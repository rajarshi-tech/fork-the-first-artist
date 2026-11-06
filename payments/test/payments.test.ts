/**
 * Paywall + meter tests (step 05).
 *
 * These are the tests that matter most in the package, because they pin down the
 * promise the whole project is sold on:
 *
 *   **a fan is never charged for an answer that failed or degraded.**
 *
 * That promise is only real if `settle()` is not reached on those paths, so every
 * assertion here checks BOTH the HTTP response AND that no settlement happened —
 * via a gate wrapper that counts settle() calls.
 *
 * No HTTP server is started: `handleAsk`/`handleMeter` take a `Ctx`, so a fake one
 * is enough and each test is a few milliseconds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, type Config } from '../src/config.ts';
import { createMockGate } from '../src/gate/index.ts';
import type { Gate } from '../src/gate/index.ts';
import { SpendLog } from '../src/spend-log.ts';
import { handleAsk, ASK_PATH, type StewardReply } from '../src/paywall.ts';
import { handleMeter, METER_PATH } from '../src/meter.ts';

// --------------------------------------------------------------------------- harness

/**
 * A gate wrapper that records how many times settle() was called.
 *
 * Every "was the fan charged?" assertion in this file goes through this counter
 * rather than through the ledger, because the ledger could be right while the
 * settlement is wrong.
 */
function countingGate(inner: Gate): Gate & { settled: number } {
  const wrapped = {
    settled: 0,
    kind: inner.kind,
    challenge: inner.challenge.bind(inner),
    verify: inner.verify.bind(inner),
    settle: async (input: { handle: unknown; requirements: never }) => {
      wrapped.settled++;
      return inner.settle(input);
    },
  };
  return wrapped as Gate & { settled: number };
}

/** Minimal `Ctx` double: enough of a request/response to drive the handlers. */
function fakeCtx(opts: {
  pathname: string;
  body?: unknown;
  headers?: Record<string, string>;
}): { ctx: Parameters<typeof handleAsk>[0]; captured: { status: number; body: any; headers: Record<string, string> } } {
  const captured = { status: 0, body: undefined as any, headers: {} as Record<string, string> };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(payload: string) {
      captured.body = JSON.parse(payload);
      return res;
    },
  } as unknown as ServerResponse;

  const req = { headers: opts.headers ?? {} } as unknown as IncomingMessage;
  const ctx = {
    req,
    res,
    url: new URL(`http://localhost:8402${opts.pathname}`),
    body: opts.body,
    raw: opts.body === undefined ? '' : JSON.stringify(opts.body),
  };
  return { ctx, captured };
}

const freshEnv = async (overrides: Partial<Config> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'oso-05-'));
  const cfg = loadConfig({
    mode: 'dev',
    ledgerPath: join(dir, 'spend-log.jsonl'),
    ...overrides,
  });
  const gate = countingGate(createMockGate(cfg));
  return {
    cfg,
    gate,
    spendLog: new SpendLog(cfg),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

/** A fetch double that returns the steward's canned answer envelope. */
const stewardFetch = (reply: StewardReply) =>
  (async () => new Response(JSON.stringify(reply), { status: reply.ok ? 200 : 422 })) as unknown as typeof fetch;

const okSteward: StewardReply = {
  ok: true,
  reply: { text: 'Shaka is a Mumbai percussionist.' },
  provider: 'fake',
  model: 'fake-1',
  provenance: { requestId: 'dev-req-abc', teeVerified: true },
};

// --------------------------------------------------------------------------- paywall

test('paywall: 402 without payment, then a paid answer with split proof', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    // 1. no payment -> a 402 challenge, nothing settled
    const first = fakeCtx({ pathname: ASK_PATH, body: { instruction: 'who are you?' } });
    await handleAsk(first.ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(okSteward) });
    assert.equal(first.captured.status, 402);
    assert.equal(first.captured.body.x402Version, 2);
    assert.equal(first.captured.body.accepts[0].amount, '100000');
    assert.equal(gate.settled, 0, 'no payment: nothing may settle');

    // 2. with payment -> an answer, exactly one settlement, split recorded
    const second = fakeCtx({
      pathname: ASK_PATH,
      body: { instruction: 'who are you?' },
      headers: { 'x-payment': 'payer=0.0.1234' },
    });
    await handleAsk(second.ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(okSteward) });
    assert.equal(second.captured.status, 200);
    assert.equal(second.captured.body.ok, true);
    assert.equal(second.captured.body.reply.text, 'Shaka is a Mumbai percussionist.');
    assert.equal(gate.settled, 1);

    // the split is 96.31 / 3.69 of 0.10 USDC
    assert.equal(second.captured.body.split.artistAtomic, '96310');
    assert.equal(second.captured.body.split.agentAtomic, '3690');
    assert.match(second.captured.body.split.human, /0\.096310 artist \/ 0\.003690 agent/);

    // the proof binds the payment to the upstream request — the submission artifact
    assert.match(second.captured.body.proof.paymentTxId, /^mock-/);
    assert.equal(second.captured.body.proof.upstream.requestId, 'dev-req-abc');
    assert.match(second.captured.body.proof.hashScan, /hashscan\.io\/testnet/);
    assert.equal(second.captured.body.proof.payTo, cfg.accounts.artist, 'money goes to the artist');

    // and the ledger has exactly one ask line
    const recent = await spendLog.recent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.kind, 'ask');
  } finally {
    await cleanup();
  }
});

test('paywall: a steward outage charges nobody', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { ctx, captured } = fakeCtx({
      pathname: ASK_PATH,
      body: { instruction: 'hello' },
      headers: { 'x-payment': 'payer=0.0.1234' },
    });
    await handleAsk(ctx, { cfg, gate, spendLog, fetchImpl: failing });

    assert.equal(captured.status, 502);
    assert.equal(captured.body.settled, false);
    assert.equal(gate.settled, 0, 'a failed answer must never be charged');
    assert.equal((await spendLog.recent()).length, 0, 'and must leave no spend line');
  } finally {
    await cleanup();
  }
});

test('paywall: a degraded template answer is free, not merely cheap', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const degraded: StewardReply = {
      ok: true,
      reply: { text: 'I am out of compute budget — here is a card.' },
      degradation: 'template-reply',
    };
    const { ctx, captured } = fakeCtx({
      pathname: ASK_PATH,
      body: { instruction: 'hello' },
      headers: { 'x-payment': 'payer=0.0.1234' },
    });
    await handleAsk(ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(degraded) });

    assert.equal(captured.status, 200);
    assert.equal(captured.body.charged, false);
    assert.equal(captured.body.settled, false);
    assert.equal(captured.body.proof, null);
    assert.equal(gate.settled, 0, 'a canned reply costs the agent nothing and must cost the fan nothing');
  } finally {
    await cleanup();
  }
});

test('paywall: a steward refusal is a 422 that says nothing was settled', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const refused: StewardReply = {
      ok: false,
      error: { code: 'NO_CONSENT', message: 'artist has not consented', retryable: false },
    };
    const { ctx, captured } = fakeCtx({
      pathname: ASK_PATH,
      body: { instruction: 'hello' },
      headers: { 'x-payment': 'payer=0.0.1234' },
    });
    await handleAsk(ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(refused) });

    assert.equal(captured.status, 422);
    assert.equal(captured.body.error, 'NO_CONSENT');
    assert.equal(captured.body.settled, false);
    assert.equal(gate.settled, 0);
  } finally {
    await cleanup();
  }
});

test('paywall: an empty instruction is a 400 before any payment talk', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const { ctx, captured } = fakeCtx({ pathname: ASK_PATH, body: { instruction: '   ' } });
    await handleAsk(ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(okSteward) });
    assert.equal(captured.status, 400);
    assert.equal(captured.body.error, 'MISSING_INSTRUCTION');
    assert.equal(gate.settled, 0);
  } finally {
    await cleanup();
  }
});

test('paywall: ?payTo= routes funds to the artist from their ENS record', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const { ctx, captured } = fakeCtx({ pathname: `${ASK_PATH}?payTo=0.0.7777`, body: { instruction: 'hi' } });
    await handleAsk(ctx, { cfg, gate, spendLog, fetchImpl: stewardFetch(okSteward) });
    assert.equal(captured.status, 402);
    assert.equal(captured.body.accepts[0].payTo, '0.0.7777');
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------- meter

const meterCtx = (headers: Record<string, string> = {}) => {
  const { ctx, captured } = fakeCtx({
    pathname: METER_PATH,
    body: { model: '0gm-1.0-35b-a3b', messages: [{ role: 'user', content: 'who is the artist?' }] },
    headers,
  });
  return { ctx, captured };
};

test('meter: 402 challenge is protocol-shaped and priced', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const { ctx, captured } = meterCtx();
    await handleMeter(ctx, { cfg, gate, spendLog });

    assert.equal(captured.status, 402);
    assert.equal(captured.body.accepts[0].amount, '2000'); // 0.002 USDC
    // the meter is paid to the AGENT's own wallet, never the artist's
    assert.equal(captured.body.accepts[0].payTo, cfg.accounts.compute);
  } finally {
    await cleanup();
  }
});

test('meter: a paid call returns the answer, the payment tx and the 0G request id', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const { ctx, captured } = meterCtx({ 'x-payment': 'payer=0.0.6666' });
    await handleMeter(ctx, { cfg, gate, spendLog });

    assert.equal(captured.status, 200);
    // the upstream response is passed through, so this is a drop-in for an
    // OpenAI-compatible endpoint
    assert.equal(captured.body.object, 'chat.completion');
    assert.match(captured.body.choices[0].message.content, /dev-mock inference/);

    // ...plus the audit block
    assert.match(captured.body.x_meter.paymentTxId, /^mock-/);
    assert.match(captured.body.x_meter.upstream.requestId, /^dev-req-/);
    assert.equal(captured.body.x_meter.upstream.teeVerified, true);
    assert.equal(gate.settled, 1);

    const recent = await spendLog.recent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.kind, 'meter');
    assert.ok(recent[0]!.upstreamRequestId, 'the 0G request id is recorded with the payment');
  } finally {
    await cleanup();
  }
});

test('meter: budget exhaustion refuses with 403 before quoting a payment', async () => {
  // a total cap below one call's price: the very first call must be refused
  const { cfg, gate, spendLog, cleanup } = await freshEnv({
    budget: { totalUsd: 0.0001, hourlyUsd: 0.05, maxPerCallUsd: 0.01 },
  });
  try {
    const { ctx, captured } = meterCtx({ 'x-payment': 'payer=0.0.6666' });
    await handleMeter(ctx, { cfg, gate, spendLog });

    // 403, not 402: never invite a payment we cannot serve
    assert.equal(captured.status, 403);
    assert.equal(captured.body.code, 'SPEND_CAP_EXCEEDED');
    assert.equal(captured.body.scope, 'total');
    assert.equal(gate.settled, 0, 'out of budget: nothing may settle');
    assert.equal((await spendLog.recent()).length, 0);
  } finally {
    await cleanup();
  }
});

test('meter: the hourly ceiling is enforced separately from the total', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv({
    budget: { totalUsd: 100, hourlyUsd: 0.0001, maxPerCallUsd: 0.01 },
  });
  try {
    const { ctx, captured } = meterCtx({ 'x-payment': 'payer=0.0.6666' });
    await handleMeter(ctx, { cfg, gate, spendLog });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.scope, 'hourly');
  } finally {
    await cleanup();
  }
});

test('meter: /meter/info advertises the price and budget without needing payment', async () => {
  const { cfg, gate, spendLog, cleanup } = await freshEnv();
  try {
    const { ctx, captured } = fakeCtx({ pathname: '/meter/info' });
    await handleMeter(ctx, { cfg, gate, spendLog });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.priceAtomic, '2000');
    assert.equal(captured.body.payTo, cfg.accounts.compute);
    assert.equal(captured.body.spent.calls, 0);
  } finally {
    await cleanup();
  }
});
