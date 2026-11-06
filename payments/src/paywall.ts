/**
 * The PAYWALL — a fan (or a fan's agent) pays the artist's steward per question.
 *
 * ```
 *   402  ──►  verify  ──►  steward answers  ──►  settle  ──►  200
 * ```
 *
 * ## Settlement is last, and that is the product promise
 *
 * If the steward is down, refusing, or the model failed, the fan is **not
 * charged**. That is not a nicety — it is the difference between "a payment rail"
 * and "a payment rail that takes money for errors". It only works because
 * `gate.settle()` is the final call in this function and every failure path
 * returns before it.
 *
 * ## Where the money goes
 *
 * `payTo` comes from the artist's own ENS text record (`?payTo=`), falling back to
 * the configured artist account. It is **never** an account of ours. The 3.69%
 * agent share is recorded in the ledger here and, in a mainnet-shaped deployment,
 * is enforced by an HTS fractional custom fee on the asset — see
 * `scripts/create-tip-token.ts`. One x402 `exact` payment is one transfer to one
 * `payTo`, so the split cannot happen during settlement.
 *
 * ## The degraded-answer rule
 *
 * If the steward hands back a template reply (`degradation: 'template-reply'`), the
 * agent spent nothing on compute, so the fan is charged nothing. Settling there
 * would take 0.10 USDC in exchange for a canned card.
 */
import type { Config } from './config.ts';
import type { Gate, PaymentRequirementsView } from './gate/index.ts';
import type { SpendLog } from './spend-log.ts';
import { atomicToDecimal } from './config.ts';
import { splitAtomic, describeSplit } from './split.ts';
import { header, log, sendJson, type Ctx } from './http.ts';

export interface PaywallDeps {
  cfg: Config;
  gate: Gate;
  spendLog: SpendLog;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

/**
 * The steward's answer envelope, as returned by the agent service over HTTP.
 *
 * Kept structurally typed here rather than imported from `agent/` on purpose: the
 * two packages must stay independently installable, and the repo owner may
 * re-implement them in either order. A shared type import would couple them and
 * break that.
 */
export interface StewardReply {
  ok: boolean;
  reply?: { text: string; data?: unknown };
  provider?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  /** the audit trail that makes a 0G answer checkable against a payment */
  provenance?: {
    requestId?: string;
    teeVerified?: boolean | null;
    paymentTxId?: string;
    hcsTxId?: string;
  };
  toolCalls?: unknown[];
  /** `'template-reply'` etc. — a non-LLM answer, which must never be charged */
  degradation?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export const ASK_PATH = '/ask';

/**
 * The priced resource, with `payTo` resolved to the artist.
 *
 * Deliberately a separate function from `gate.challenge()`: this object is what we
 * hand to `verify()` and `settle()`, and it must be **the identical value** in all
 * three calls or the facilitator will reject the payment as mismatched.
 */
function requirementsFor(cfg: Config, resource: string, payTo: string): PaymentRequirementsView {
  return {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.prices.askAtomic.toString(),
    asset: cfg.asset.id,
    payTo,
    resource,
    description: 'ask the artist steward a question',
    maxTimeoutSeconds: 180,
  };
}

export async function handleAsk(ctx: Ctx, deps: PaywallDeps): Promise<void> {
  const { cfg, gate, spendLog } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const resource = `${ctx.url.origin}${ASK_PATH}`;

  // ---------------------------------------------------------------- input
  const body = (ctx.body ?? {}) as { instruction?: string; question?: string; artist?: string };
  // `question` is accepted as an alias of `instruction` and `?q=` exists so the
  // endpoint can be exercised from a browser address bar during a demo.
  const instruction = (body.instruction ?? body.question ?? ctx.url.searchParams.get('q') ?? '').trim();
  if (!instruction) {
    sendJson(ctx.res, 400, {
      error: 'MISSING_INSTRUCTION',
      message: 'send { "instruction": "..." }',
    });
    return;
  }

  // ---------------------------------------------------------------- payee
  // The fan's client may name the payee explicitly (it reads it from the artist's
  // ENS record). Falling back to config keeps a single-artist demo simple.
  const payTo = ctx.url.searchParams.get('payTo') ?? cfg.accounts.artist;
  if (!payTo) {
    sendJson(ctx.res, 500, {
      error: 'NO_PAYEE',
      message: 'HEDERA_ARTIST_ACCOUNT_ID not configured',
    });
    return;
  }

  // ---------------------------------------------------------------- payment
  const requirements = requirementsFor(cfg, resource, payTo);
  const paymentHeader = header(ctx.req, 'x-payment');
  const verified = await gate.verify({ paymentHeader, requirements });
  if (!verified.ok) {
    // Not an error: quoting the price IS the protocol. The gate's rejection reason
    // is folded into the challenge so a client sees *why* it must (re)pay.
    const challenge = await gate.challenge({
      resource,
      amountAtomic: cfg.prices.askAtomic,
      payTo,
      description: requirements.description,
    });
    sendJson(
      ctx.res,
      challenge.status,
      { ...challenge.body, error: verified.reason ?? challenge.body.error },
      challenge.headers,
    );
    return;
  }

  // ---------------------------------------------------------------- steward answers
  let stewarded: StewardReply;
  try {
    stewarded = await callSteward(cfg, instruction, { payer: verified.payer }, doFetch);
  } catch (err) {
    // no settlement on failure: the fan keeps their money
    log.error('steward failed', { err: (err as Error).message });
    sendJson(ctx.res, 502, {
      error: 'STEWARD_UNAVAILABLE',
      message: (err as Error).message,
      settled: false,
      hint: 'no payment was taken for this request',
    });
    return;
  }

  if (!stewarded.ok) {
    // The steward refused (spend cap, missing consent, schema failure). 422 rather
    // than 5xx: the request was understood and deliberately declined.
    sendJson(ctx.res, 422, {
      error: stewarded.error?.code ?? 'STEWARD_REFUSED',
      message: stewarded.error?.message ?? 'steward could not answer',
      settled: false,
    });
    return;
  }

  // A degraded (template) answer cost the agent nothing, so the fan is not
  // charged. Settling here would take 0.10 USDC for a canned card.
  if (stewarded.degradation === 'template-reply') {
    sendJson(ctx.res, 200, {
      ok: true,
      reply: stewarded.reply,
      provider: stewarded.provider,
      model: stewarded.model,
      degradation: stewarded.degradation,
      charged: false,
      settled: false,
      proof: null,
      note: 'the agent is at its compute budget; you were not charged',
    });
    return;
  }

  // ---------------------------------------------------------------- settle
  const settlement = await gate.settle({ handle: verified.handle, requirements });
  // `unsent-` is self-labelling: if settle somehow produced no id, the ledger says
  // so instead of inventing something that looks like a transaction.
  const txId = settlement.txId ?? `unsent-${Date.now().toString(36)}`;
  const split = splitAtomic(cfg.prices.askAtomic, cfg.split);

  const entry = await spendLog.append({
    kind: 'ask',
    txId,
    priceAtomic: cfg.prices.askAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.askAtomic, cfg.asset.decimals),
    payer: settlement.payer ?? verified.payer,
    upstreamRequestId: stewarded.provenance?.requestId,
    teeVerified: stewarded.provenance?.teeVerified ?? null,
    model: stewarded.model,
    artistAtomic: split.artist.toString(),
    agentAtomic: split.agent.toString(),
  });

  // x402's settlement receipt, base64 in a response header, so a client can read
  // the proof without parsing our JSON body.
  const settleHeader = Buffer.from(
    JSON.stringify({
      success: settlement.success,
      transaction: txId,
      network: settlement.network ?? cfg.network,
      payer: settlement.payer ?? verified.payer,
    }),
  ).toString('base64');

  sendJson(
    ctx.res,
    200,
    {
      ok: true,
      reply: stewarded.reply,
      provider: stewarded.provider,
      model: stewarded.model,
      usage: stewarded.usage,
      costUsd: stewarded.costUsd,
      degradation: stewarded.degradation,
      split: {
        totalAtomic: split.total.toString(),
        artistAtomic: split.artist.toString(),
        agentAtomic: split.agent.toString(),
        human: describeSplit(split, cfg.asset.decimals),
      },
      proof: {
        paymentTxId: txId,
        network: settlement.network ?? cfg.network,
        asset: cfg.asset.id,
        payer: settlement.payer ?? verified.payer,
        payTo,
        hcsTxId: entry.hcsTxId ?? null,
        // The point of binding these two ids: one payment tx ↔ one inference
        // request. That pair is the 0G + Hedera proof artifact for the submission.
        upstream: {
          requestId: stewarded.provenance?.requestId ?? null,
          teeVerified: stewarded.provenance?.teeVerified ?? null,
          provider: stewarded.provider ?? null,
          model: stewarded.model ?? null,
        },
        hashScan:
          settlement.network === 'hedera:mainnet'
            ? `https://hashscan.io/mainnet/transaction/${txId}`
            : `https://hashscan.io/testnet/transaction/${txId}`,
      },
    },
    { 'x-payment-response': settleHeader },
  );
}

/**
 * Ask the steward service for an answer.
 *
 * @throws on a network failure, a non-JSON body, or any status other than 200/422.
 *         422 is *not* thrown: it is the steward's structured refusal and the caller
 *         turns it into a 422 of its own. Everything else is an infrastructure
 *         failure and must not be presented to the fan as a refusal.
 */
async function callSteward(
  cfg: Config,
  instruction: string,
  payment: { payer?: string },
  doFetch: typeof fetch,
): Promise<StewardReply> {
  const res = await doFetch(`${cfg.stewardUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // the payer id is forwarded so the steward's own logs can correlate the two
    // services for one fan question
    body: JSON.stringify({ instruction, payment }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`steward returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok && res.status !== 422) {
    throw new Error(`steward ${res.status}: ${text.slice(0, 200)}`);
  }
  return parsed as StewardReply;
}
