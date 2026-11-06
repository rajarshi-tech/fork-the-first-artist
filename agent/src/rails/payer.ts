/**
 * The steward's wallet. This is what makes the agent autonomous: it pays for its
 * own inference, per call, with no human approving anything.
 *
 *   mock   — no wallet key configured: sends a dev X-PAYMENT header. The meter in
 *            dev mode accepts it. Lets the whole loop run offline.
 *   hedera — real x402: on 402, sign a partially-signed Hedera TransferTransaction
 *            with @x402/hedera, retry with X-PAYMENT, let the facilitator settle.
 *
 * `setSpendControls` is the SDK's built-in guard (per-payment cap + asset
 * allowlist) - the "spending controls for agents" requirement, enforced
 * client-side as a second line of defence behind the meter's own budget.
 *
 * ## Why the payer wraps `fetch` instead of being called explicitly
 *
 * The steward does not know it is paying. It calls a provider, the provider calls
 * `payer.fetch`, and the 402 -> sign -> retry handshake happens inside this wrapper.
 * That is the x402 model: payment is a *transport concern*. It also means the payment
 * code has exactly one entry point (`fetch`) and cannot be reached by a model deciding
 * to call something - there is no `pay()` for a prompt injection to invoke.
 *
 * ## Two independent spend ceilings
 *
 * | Where | What it protects |
 * |---|---|
 * | `setSpendControls` here | a single payment cannot exceed `maxAmountPerPayment` |
 * | `payments/src/meter.ts` budget gate | the steward's *total* spend over time |
 *
 * Neither is sufficient alone: the client cap cannot see history, the server gate
 * cannot stop a compromised client. Both are checked.
 */
import type { Provenance } from '../types.ts';

export interface Payer {
  kind: 'mock' | 'hedera';
  accountId?: string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface PayerOptions {
  accountId?: string;
  privateKey?: string;
  network?: string;
  /** hard client-side ceiling per payment, USD (default $1) */
  maxAmountPerPayment?: string;
  timeoutMs?: number;
}

/**
 * Create the wallet.
 *
 * @returns `{ kind: 'mock' }` when no `HEDERA_AGENT_PRIVATE_KEY` is configured - the
 *          meter must then be in `PAYMENTS_MODE=dev` to accept it. This is what makes
 *          the whole loop runnable offline with zero credentials.
 */
export async function createPayer(opts: PayerOptions = {}): Promise<Payer> {
  const accountId = opts.accountId ?? process.env.HEDERA_AGENT_ACCOUNT_ID ?? '';
  const privateKey = opts.privateKey ?? process.env.HEDERA_AGENT_PRIVATE_KEY;
  const network = opts.network ?? process.env.HEDERA_NETWORK ?? 'hedera:testnet';

  if (!privateKey) {
    // Dev payer: no key, no chain. The meter must be in PAYMENTS_MODE=dev too.
    return {
      kind: 'mock',
      accountId: accountId || undefined,
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        headers.set('x-payment', `mock payer=${accountId || '0.0.0000'}`);
        return fetch(url, { ...init, headers });
      },
    };
  }

  const client = await buildX402Client({ accountId, privateKey, network, maxAmountPerPayment: opts.maxAmountPerPayment });

  return {
    kind: 'hedera',
    accountId,
    async fetch(url, init) {
      // Try unauthenticated first. A metered endpoint answers 402; anything else
      // (200, 500, ...) is passed through untouched, so a non-payment error is never
      // swallowed by the payment path.
      const first = await fetch(url, init);
      if (first.status !== 402) return first;

      const raw = await first.text();
      let challenge: { x402Version?: number; accepts?: unknown[] };
      try {
        challenge = JSON.parse(raw) as typeof challenge;
      } catch {
        throw new Error(`402 from ${url} was not JSON: ${raw.slice(0, 200)}`);
      }
      if (!challenge.accepts?.length) {
        throw new Error(`402 from ${url} had no payment requirements: ${raw.slice(0, 200)}`);
      }

      // Sign exactly what the server asked for. We do NOT invent requirements; we
      // echo `accepts` back signed. A server asking for an asset outside the
      // allowlist is refused by setSpendControls, not by us.
      const paymentPayload = await client.createPaymentPayload({
        x402Version: challenge.x402Version ?? 2,
        accepts: challenge.accepts,
      } as never);
      const header = client.encodePaymentSignatureHeader(paymentPayload);

      const headers = new Headers(init?.headers);
      headers.set('X-PAYMENT', header);
      return fetch(url, { ...init, headers });
    },
  };
}

interface X402ClientLike {
  createPaymentPayload(paymentRequired: unknown): Promise<unknown>;
  encodePaymentSignatureHeader(payload: unknown): string;
}

/**
 * Build the real x402 client lazily.
 *
 * The `import()`s are dynamic on purpose: the x402 packages and the Hedera SDK are
 * `optionalDependencies`, so a dev-mode checkout can run with none of them installed.
 * Only an operator who actually configured a key pays the install cost - and gets a
 * clear error naming all three packages if they are missing.
 */
async function buildX402Client(opts: {
  accountId: string;
  privateKey: string;
  network: string;
  maxAmountPerPayment?: string;
}): Promise<X402ClientLike> {
  // dynamic: dev mode does not need these packages installed at all
  const [{ x402Client }, { encodePaymentSignatureHeader }, hedera] = await Promise.all([
    import('@x402/core/client'),
    import('@x402/core/http'),
    import('@x402/hedera'),
  ]).catch((err: unknown) => {
    throw new Error(
      `Hedera payment needs @x402/core, @x402/hedera and @hiero-ledger/sdk installed: ${(err as Error).message}`,
    );
  });

  const { ExactHederaScheme } = await import('@x402/hedera/exact/client');
  const signer = hedera.createClientHederaSigner(
    opts.accountId,
    hedera.PrivateKey.fromStringECDSA(opts.privateKey),
    { network: opts.network },
  );

  const client = new x402Client()
    .register(opts.network as `${string}:${string}`, new ExactHederaScheme(signer))
    .setSpendControls({ maxAmountPerPayment: opts.maxAmountPerPayment ?? '$1' });

  return {
    createPaymentPayload: (pr) => client.createPaymentPayload(pr as never),
    encodePaymentSignatureHeader: (p) => encodePaymentSignatureHeader(p as never),
  };
}

/** Pull the settlement tx id + upstream provenance out of a paid response. */
export function readMeterProvenance(payload: {
  x_meter?: {
    paymentTxId?: string;
    hcsTxId?: string | null;
    upstream?: { requestId?: string | null; teeVerified?: boolean | null };
  };
}): Provenance {
  const m = payload.x_meter;
  return {
    paymentTxId: m?.paymentTxId,
    hcsTxId: m?.hcsTxId ?? null,
    requestId: m?.upstream?.requestId ?? undefined,
    teeVerified: m?.upstream?.teeVerified ?? null,
  };
}
