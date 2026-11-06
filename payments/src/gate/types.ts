/**
 * The payment gate — **the only interface the meter and the paywall use.**
 *
 * Two implementations, one contract:
 *
 * | Implementation | Mode  | What it does |
 * |---|---|---|
 * | `createMockGate`  | `dev` | protocol-shaped 402 challenges, no chain, no keys, instant, deterministic enough to test |
 * | `createHederaGate`| `live`| real x402 on Hedera testnet, settled by a facilitator (`gate/hedera.ts`) |
 *
 * ## The three-call contract
 *
 * ```
 *   challenge()          verify()            settle()
 *   ────────► 402        ────────► payer?    ────────► txId
 *   (price it)          (is the signed      (move the funds,
 *                        transfer valid?)     AFTER the handler ran)
 * ```
 *
 * `settle()` is deliberately the **last** call, made only once the handler has
 * produced an answer. That ordering is the whole reason a fan is never charged
 * for an answer that failed — see `paywall.ts`.
 *
 * ## Why this interface exists at all
 *
 * The rest of the service never imports `@x402/*` or the Hedera SDK. All
 * sponsor-specific code lives in `hedera.ts`, which is dynamically imported only
 * when `PAYMENTS_MODE=live`. Without that boundary, `dev` mode would need three
 * heavyweight dependency trees installed just to boot — and the repo would stop
 * being demoable on a teammate's laptop.
 */
import type { Config } from '../config.ts';

/**
 * The priced resource, in the exact shape the x402 v2 wire format expects.
 *
 * Field names are **not** ours: they are copied from `@x402/core@2.30.0`'s
 * `paymentRequirementsSchema`. Do not rename them — a client on the other end
 * parses this object literally.
 */
export interface PaymentRequirementsView {
  /** only `exact` is implemented; `upto`, `stream` etc. are out of scope */
  scheme: 'exact';
  /** CAIP-2-style id, e.g. `hedera:testnet` */
  network: string;
  /** atomic units as a **string** — JSON cannot carry bigint, and a float would lose precision */
  amount: string;
  /** asset id, e.g. `0.0.429274` (testnet USDC) */
  asset: string;
  /** where the money lands. For `/ask` this is the ARTIST's own account. */
  payTo: string;
  /** the resource id, e.g. `/ask` */
  resource: string;
  description?: string;
  /** how long the challenge stays valid, seconds */
  maxTimeoutSeconds: number;
  /** facilitator hints, e.g. `{ feePayer }` */
  extra?: Record<string, unknown>;
}

/** A ready-to-send 402. `body` and the `payment-required` header carry the same data. */
export interface Challenge {
  status: 402;
  body: {
    x402Version: 2;
    accepts: PaymentRequirementsView[];
    /** human-readable reason; must not leak whether the payer is known */
    error?: string;
  };
  headers: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  /** the account the payment came from, when known */
  payer?: string;
  /** why it was rejected, when `ok === false` */
  reason?: string;
  /** opaque to callers — gate-private state it needs in order to settle later */
  handle?: unknown;
}

export interface SettleResult {
  success: boolean;
  /** the Hedera transaction id (or a mock equivalent). This is the proof string. */
  txId?: string;
  payer?: string;
  network?: string;
  errorReason?: string;
}

export interface Gate {
  /** which implementation this is, for logs and the `/health` response */
  readonly kind: 'mock' | 'hedera';

  /** Build a 402 challenge for a priced resource. Cheap and side-effect free. */
  challenge(input: {
    resource: string;
    amountAtomic: bigint;
    payTo: string;
    description?: string;
  }): Promise<Challenge>;

  /**
   * Validate an inbound `X-PAYMENT` header against the requirements.
   * **Does not move funds** — so calling it twice is harmless.
   */
  verify(input: {
    paymentHeader?: string;
    requirements: PaymentRequirementsView;
  }): Promise<VerifyResult>;

  /**
   * Move funds. Called **after** the handler succeeded.
   *
   * @param handle whatever `verify()` returned in `VerifyResult.handle`.
   */
  settle(input: {
    handle: unknown;
    requirements: PaymentRequirementsView;
  }): Promise<SettleResult>;
}

/**
 * Dev gate: the real protocol shape, none of the chain.
 *
 * It exists so that two things are true at once:
 *  - the *shape* of what we send is the real x402 v2 shape, so client code
 *    written against dev mode works unchanged against live mode;
 *  - nothing in dev needs keys, accounts, a network or an installed SDK.
 *
 * The transaction ids it emits are prefixed `mock-` so they can never be mistaken
 * for a settled transfer. `extra.devMock = true` says the same thing on the wire.
 */
export function createMockGate(cfg: Config): Gate {
  const payee = cfg.accounts.artist || '0.0.0000';

  return {
    kind: 'mock',

    async challenge({ resource, amountAtomic, payTo, description }) {
      const requirements: PaymentRequirementsView = {
        scheme: 'exact',
        network: cfg.network,
        amount: amountAtomic.toString(),
        asset: cfg.asset.id,
        payTo: payTo || payee,
        resource,
        description,
        maxTimeoutSeconds: 180,
        extra: { feePayer: '0.0.0000', devMock: true },
      };
      const body = {
        x402Version: 2 as const,
        error: 'payment required (dev mode: mock facilitator, nothing settles on chain)',
        accepts: [requirements],
      };
      return {
        status: 402,
        body,
        headers: {
          'content-type': 'application/json',
          // settlement metadata is per-payer; a shared cache must never store it
          'cache-control': 'no-store',
          // v2 wire format: an x402 client reads the challenge from this header
          'payment-required': Buffer.from(JSON.stringify(body)).toString('base64'),
        },
      };
    },

    async verify({ paymentHeader }) {
      // Any non-empty header is "valid" here: dev mode is for exercising the
      // flow, not for pretending to check a signature. The payer id is scraped
      // out of the header purely so the ledger has something to print.
      if (!paymentHeader) return { ok: false, reason: 'missing X-PAYMENT header' };
      const payer = /payer=(0\.0\.\d+)/.exec(paymentHeader)?.[1] ?? '0.0.0000';
      return { ok: true, payer, handle: { paymentHeader, payer } };
    },

    async settle({ handle }) {
      const payer = (handle as { payer?: string })?.payer ?? '0.0.0000';
      return {
        success: true,
        // `mock-` prefix is load-bearing: never confusable with a real tx id
        txId: `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        payer,
        network: cfg.network,
      };
    },
  };
}
