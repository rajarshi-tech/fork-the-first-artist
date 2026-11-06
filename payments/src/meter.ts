/**
 * The METER — a pay-per-call, OpenAI-compatible inference proxy.
 *
 * ## Why it exists
 *
 * The artist's steward must **pay for its own thinking**, per request, from its own
 * 3.69% wallet, with no human top-up. This endpoint is the thing it pays. One
 * component serves both sponsors at once:
 *
 * | Sponsor | What this endpoint gives them |
 * |---|---|
 * | **Hedera** | an x402-protected endpoint that settles on Hedera testnet, called by an autonomous agent — their "AI Agents That Pay" example verbatim |
 * | **0G** | every response carries the upstream router `request_id` and `tee_verified`, **bound 1:1 to a payment tx id**. That pair is the proof artifact |
 *
 * ## Order of operations
 *
 * ```
 *   budget check ──► 402 ──► verify ──► INFER ──► settle ──► log ──► respond
 * ```
 *
 * Two orderings carry the guarantees:
 *
 * 1. **The budget check is BEFORE the 402.** Never quote a payment we are not
 *    allowed to serve. If we quoted first and refused after, a client would have a
 *    signed payment for a call that can never be honoured.
 * 2. **Settlement is after inference.** A failed inference costs the payer nothing.
 *
 * ## Why 403 and not 402 for the spend cap
 *
 * A 402 says "pay me". Returning it when we mean "I am out of money and will
 * refuse" would invite a payment we cannot serve. **403 `SPEND_CAP_EXCEEDED`** is
 * the honest answer, and it is a *signal*, not an error: the steward's degradation
 * ladder turns it into a template reply and the fan is not charged either.
 */
import type { Config } from './config.ts';
import type { Gate, PaymentRequirementsView } from './gate/index.ts';
import type { SpendLog } from './spend-log.ts';
import { atomicToDecimal } from './config.ts';
import { header, log, parseJson, sendJson, type Ctx } from './http.ts';

export interface MeterDeps {
  cfg: Config;
  gate: Gate;
  spendLog: SpendLog;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

export const METER_PATH = '/meter/v1/chat/completions';
const MODELS_PATH = '/meter/v1/models';
const INFO_PATH = '/meter/info';

interface MeterInfo {
  priceAtomic: string;
  priceUsd: string;
  asset: string;
  network: string;
  payTo: string;
  budget: { totalUsd: number; hourlyUsd: number; maxPerCallUsd: number };
  upstream: { baseUrl: string; model: string; trustMode: string };
}

/** Public description of the meter. Exposed on `/meter/info` so a client can self-configure. */
export function meterInfo(cfg: Config): MeterInfo {
  return {
    priceAtomic: cfg.prices.meterAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
    asset: cfg.asset.id,
    network: cfg.network,
    // the 3.69% wallet — this endpoint is paid to the AGENT, not the artist
    payTo: cfg.accounts.compute || '0.0.0000',
    budget: cfg.budget,
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      model: cfg.upstream.model,
      trustMode: cfg.upstream.trustMode,
    },
  };
}

function requirementsFor(
  cfg: Config,
  resource: string,
  description: string,
): PaymentRequirementsView {
  return {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.prices.meterAtomic.toString(),
    asset: cfg.asset.id,
    payTo: cfg.accounts.compute || '0.0.0000',
    resource,
    description,
    maxTimeoutSeconds: 180,
  };
}

export async function handleMeter(ctx: Ctx, deps: MeterDeps): Promise<void> {
  const { cfg, gate, spendLog } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  if (ctx.url.pathname === INFO_PATH) {
    const totals = await spendLog.totals();
    sendJson(ctx.res, 200, { ...meterInfo(cfg), spent: totals });
    return;
  }

  const resource = `${ctx.url.origin}${METER_PATH}`;

  // ---------------------------------------------------------------- budget gate
  // BEFORE the 402 on purpose: never quote a payment we are not allowed to serve.
  const totals = await spendLog.totals();
  const priceUsd = Number(atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals));

  if (totals.totalUsd + priceUsd > cfg.budget.totalUsd) {
    sendJson(ctx.res, 403, {
      error: 'SPEND_CAP_EXCEEDED',
      code: 'SPEND_CAP_EXCEEDED',
      scope: 'total',
      spentUsd: totals.totalUsd,
      capUsd: cfg.budget.totalUsd,
      hint: 'steward is out of compute budget — degrade to a template reply',
    });
    return;
  }
  if (totals.lastHourUsd + priceUsd > cfg.budget.hourlyUsd) {
    sendJson(ctx.res, 403, {
      error: 'SPEND_CAP_EXCEEDED',
      code: 'SPEND_CAP_EXCEEDED',
      scope: 'hourly',
      spentLastHourUsd: totals.lastHourUsd,
      capUsd: cfg.budget.hourlyUsd,
    });
    return;
  }

  // ---------------------------------------------------------------- payment
  const requirements = requirementsFor(cfg, resource, `inference call (${cfg.upstream.model})`);
  const paymentHeader = header(ctx.req, 'x-payment');
  const verified = await gate.verify({ paymentHeader, requirements });
  if (!verified.ok) {
    const challenge = await gate.challenge({
      resource,
      amountAtomic: cfg.prices.meterAtomic,
      payTo: cfg.accounts.compute,
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

  // ---------------------------------------------------------------- infer
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  let upstream: {
    payload: Record<string, unknown>;
    requestId?: string;
    teeVerified?: boolean | null;
    costRaw?: string;
    model: string;
  };
  try {
    upstream = await callUpstream(cfg, body, doFetch);
  } catch (err) {
    // No settlement on failure: the payer keeps their money.
    log.error('upstream inference failed', { err: (err as Error).message });
    sendJson(ctx.res, 502, {
      error: 'UPSTREAM_FAILED',
      message: (err as Error).message,
      settled: false,
      hint: 'no payment was taken for this request',
    });
    return;
  }

  // ---------------------------------------------------------------- settle
  const settlement = await gate.settle({ handle: verified.handle, requirements });
  const txId = settlement.txId ?? `unsent-${Date.now().toString(36)}`;

  const entry = await spendLog.append({
    kind: 'meter',
    txId,
    priceAtomic: cfg.prices.meterAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
    payer: settlement.payer ?? verified.payer,
    upstreamRequestId: upstream.requestId,
    teeVerified: upstream.teeVerified ?? null,
    model: upstream.model,
  });

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
      // the upstream response is passed through unchanged, so the meter is a
      // drop-in replacement for an OpenAI-compatible endpoint...
      ...upstream.payload,
      // ...plus one extra block that makes it auditable
      x_meter: {
        paidAtomic: cfg.prices.meterAtomic.toString(),
        paidUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
        paymentTxId: txId,
        network: cfg.network,
        payer: settlement.payer ?? verified.payer,
        hcsTxId: entry.hcsTxId ?? null,
        upstream: {
          provider: '0g',
          model: upstream.model,
          requestId: upstream.requestId ?? null,
          teeVerified: upstream.teeVerified ?? null,
          billingRaw: upstream.costRaw ?? null,
        },
      },
    },
    { 'x-payment-response': settleHeader },
  );
}

/**
 * Forward the request to the upstream (the 0G Compute Router in the demo) and
 * capture the trace block that makes the answer auditable.
 *
 * In dev mode with no `UPSTREAM_API_KEY` we synthesise a plausible
 * OpenAI-shaped response so the whole two-service loop is demoable **offline**.
 * That response is labelled `[dev-mock inference]` and its ids are prefixed
 * `dev-`, so it can never be mistaken for a real 0G answer.
 *
 * @throws on a non-2xx upstream status, truncating the body to 300 chars so an
 *         HTML error page from a proxy does not end up in the logs.
 */
async function callUpstream(
  cfg: Config,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<{
  payload: Record<string, unknown>;
  requestId?: string;
  teeVerified?: boolean | null;
  costRaw?: string;
  model: string;
}> {
  const model = typeof body.model === 'string' ? body.model : cfg.upstream.model;

  if (cfg.mode === 'dev' && !cfg.upstream.apiKey) {
    return devUpstream(model, body);
  }

  const upstreamBody = {
    ...body,
    model,
    // ask 0G for a TEE attestation. The flag is meaningless to any other
    // provider, which is why the meter is 0G-shaped rather than generic.
    verify_tee: true,
  };

  const res = await doFetch(`${cfg.upstream.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.upstream.apiKey ?? ''}`,
      // 0G's trust-mode selector: `verified` requires an attested provider
      'X-0G-Provider-Trust-Mode': cfg.upstream.trustMode,
    },
    body: JSON.stringify(upstreamBody),
    // inference can be slow; still bounded so a hung router cannot wedge us
    signal: AbortSignal.timeout(45_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = JSON.parse(text) as Record<string, unknown> & {
    x_0g_trace?: {
      request_id?: string;
      tee_verified?: boolean | null;
      billing?: { total_cost?: string };
    };
  };

  return {
    payload,
    // The request id appears in two places; the header is authoritative when
    // present, the trace block is the fallback.
    requestId: res.headers.get('x-0g-request-id') ?? payload.x_0g_trace?.request_id,
    teeVerified: payload.x_0g_trace?.tee_verified ?? null,
    costRaw: payload.x_0g_trace?.billing?.total_cost,
    model,
  };
}

/**
 * The offline stand-in. Shape-identical to a real OpenAI completion, with every
 * field that could be mistaken for real provenance prefixed `dev-`.
 */
function devUpstream(
  model: string,
  body: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  requestId: string;
  teeVerified: boolean;
  costRaw: string;
  model: string;
} {
  const messages = Array.isArray(body.messages)
    ? (body.messages as { content?: string }[])
    : [];
  const lastUser = [...messages].reverse().find((m) => typeof m.content === 'string')?.content ?? '';
  const snippet = lastUser.slice(0, 80).replace(/\s+/g, ' ');
  return {
    model,
    requestId: `dev-req-${Math.random().toString(36).slice(2, 12)}`,
    teeVerified: true,
    costRaw: '0.00004',
    payload: {
      id: `chatcmpl-dev-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[dev-mock inference] heard: "${snippet}". Swapping in a real UPSTREAM_API_KEY gives a real 0G answer.`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 128, completion_tokens: 48, total_tokens: 176 },
      x_0g_trace: {
        request_id: `dev-req-${Date.now().toString(36)}`,
        provider: '0xdev',
        tee_verified: true,
        billing: { total_cost: '0.00004' },
      },
    },
  };
}

export { parseJson };
