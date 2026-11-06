/**
 * LIVE payment gate — real x402 on Hedera testnet, settled by a facilitator.
 *
 * ## Why we talk HTTP directly instead of using the middleware
 *
 * `@x402/core` ships a full resource-server middleware. We deliberately do not
 * use it here and speak the facilitator's three documented endpoints instead:
 *
 * | Endpoint | Meaning |
 * |---|---|
 * | `GET  /supported` | which `network`/`scheme` pairs this facilitator honours, and its `feePayer` |
 * | `POST /verify`    | is this signed transfer valid *right now*? |
 * | `POST /settle`    | submit it and give me the transaction id |
 *
 * The facilitator is the authority on validity, and its wire format is stable, so
 * a thin client is both smaller and easier for a reviewer to audit than pulling a
 * middleware stack into the request path. The field names below are **copied from
 * `@x402/core@2.30.0`'s `HTTPFacilitatorClient` and its zod schemas**, not guessed:
 *
 * ```
 * POST /verify  { x402Version, paymentPayload, paymentRequirements }
 *               -> { isValid, invalidReason?, invalidMessage?, payer? }
 *
 * POST /settle  { x402Version, paymentPayload, paymentRequirements }
 *               -> { success, transaction, network, payer?, errorReason? }
 * ```
 *
 * `transaction` from `/settle` is the Hedera transaction id — the exact string
 * that goes into `docs/TX-PROOF.md` and the submission form.
 *
 * ## Why this file has zero module-scope imports
 *
 * `createGate()` imports this module dynamically, only for `PAYMENTS_MODE=live`.
 * Type-only imports are erased at runtime, so in dev mode this file is never
 * loaded and `@x402/*` / `@hiero-ledger/sdk` need not be installed at all.
 */
import type { Config } from '../config.ts';
import type {
  Challenge,
  Gate,
  PaymentRequirementsView,
  SettleResult,
  VerifyResult,
} from './types.ts';

/** The subset of `GET /supported` we care about. */
export interface FacilitatorCapabilities {
  kinds: {
    x402Version: number;
    scheme: string;
    network: string;
    extra?: Record<string, unknown>;
  }[];
}

/**
 * The `X-PAYMENT` header payload. We do not construct one (the *client* does);
 * we only decode it to hand back to the facilitator, which validates it.
 */
interface PaymentPayloadWire {
  x402Version: number;
  scheme?: string;
  network?: string;
  payload: unknown;
  [k: string]: unknown;
}

/**
 * @param cfg must already be valid: `createGate()` only reaches here when
 *            `PAYMENTS_MODE=live`, and `loadConfig` has proven the account ids
 *            exist.
 */
export function createHederaGate(cfg: Config): Gate {
  const url = cfg.facilitatorUrl.replace(/\/+$/, '');

  /** Small JSON helper: bounded by a timeout so a hung facilitator fails the request, not the process. */
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`facilitator ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  };

  // Cached capabilities. Fetched once, lazily, on the first challenge.
  let supported: FacilitatorCapabilities | null = null;

  /**
   * One extra round-trip at most, so that pointing at a facilitator on the wrong
   * network fails **loudly and immediately** instead of producing a 402 that no
   * client can ever satisfy in the middle of a demo.
   */
  const getSupported = async (): Promise<FacilitatorCapabilities> => {
    if (supported) return supported;
    const res = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`facilitator /supported -> ${res.status}`);
    supported = (await res.json()) as FacilitatorCapabilities;
    const hasHedera = supported.kinds.some(
      (k) => k.network === cfg.network && k.scheme === 'exact',
    );
    if (!hasHedera) {
      throw new Error(
        `facilitator ${url} does not advertise ${cfg.network} exact; got ${supported.kinds
          .map((k) => `${k.network}/${k.scheme}`)
          .join(', ')}`,
      );
    }
    return supported;
  };

  /**
   * The facilitator's `feePayer`, when it publishes one.
   *
   * Hedera transfers need a payer for network fees. When the facilitator sponsors
   * them it advertises its own account here and we echo it into `extra.feePayer`
   * so the client's signature covers the right arrangement.
   */
  const feePayerFor = async (): Promise<string | undefined> => {
    const s = await getSupported();
    const kind = s.kinds.find((k) => k.network === cfg.network && k.scheme === 'exact');
    return (kind?.extra?.feePayer as string | undefined) ?? undefined;
  };

  /**
   * Decode `X-PAYMENT`.
   *
   * x402 v2 sends base64-encoded JSON (`encodePaymentSignatureHeader`). Some
   * clients and hand-written curl tests send raw JSON instead, so both are
   * accepted; anything else returns `null` and becomes a clean 402 rather than a
   * crash. We do not validate the structure — that is the facilitator's job.
   */
  const decodePayment = (header?: string): PaymentPayloadWire | null => {
    if (!header) return null;
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayloadWire;
    } catch {
      try {
        return JSON.parse(header) as PaymentPayloadWire;
      } catch {
        return null;
      }
    }
  };

  return {
    kind: 'hedera',

    async challenge({ resource, amountAtomic, payTo, description }): Promise<Challenge> {
      const feePayer = await feePayerFor();
      const requirements: PaymentRequirementsView = {
        scheme: 'exact',
        network: cfg.network,
        amount: amountAtomic.toString(),
        asset: cfg.asset.id,
        // The money goes to the artist, never to us. For `/ask` this is the
        // artist's own Hedera account as recorded in their ENS text record.
        payTo,
        resource,
        description,
        maxTimeoutSeconds: 180,
        extra: feePayer ? { feePayer } : undefined,
      };
      return {
        status: 402,
        body: { x402Version: 2, accepts: [requirements] },
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          // v2 wire format: any x402 client can read the challenge from here
          'payment-required': Buffer.from(
            JSON.stringify({
              x402Version: 2,
              error: 'payment required',
              accepts: [requirements],
            }),
          ).toString('base64'),
        },
      };
    },

    async verify({ paymentHeader, requirements }): Promise<VerifyResult> {
      const paymentPayload = decodePayment(paymentHeader);
      if (!paymentPayload) return { ok: false, reason: 'X-PAYMENT is not valid base64 JSON' };

      const out = await post<{
        isValid: boolean;
        invalidReason?: string;
        invalidMessage?: string;
        payer?: string;
      }>('/verify', { x402Version: 2, paymentPayload, paymentRequirements: requirements });

      if (!out.isValid) {
        return {
          ok: false,
          reason: out.invalidReason ?? out.invalidMessage ?? 'invalid payment',
        };
      }
      // Carry both halves forward: settle() needs exactly this pair again.
      return { ok: true, payer: out.payer, handle: { paymentPayload, requirements } };
    },

    async settle({ handle }): Promise<SettleResult> {
      const h = handle as {
        paymentPayload: PaymentPayloadWire;
        requirements: PaymentRequirementsView;
      };

      const out = await post<{
        success: boolean;
        transaction: string;
        network: string;
        payer?: string;
        errorReason?: string;
      }>('/settle', {
        x402Version: 2,
        paymentPayload: h.paymentPayload,
        paymentRequirements: h.requirements,
      });

      return {
        success: out.success,
        // only expose a tx id when it really settled — never a placeholder
        txId: out.success ? out.transaction : undefined,
        payer: out.payer,
        network: out.network,
        errorReason: out.errorReason,
      };
    },
  };
}
