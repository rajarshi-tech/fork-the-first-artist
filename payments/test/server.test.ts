/**
 * Server tests (step 06) — the wiring, not the handlers.
 *
 * These start the real `node:http` server on port 0 (an OS-assigned free port) and
 * speak to it over a real socket. That is deliberate: the handlers are already
 * unit-tested in step 05, so the only thing left to verify is that the *router*
 * maps paths and methods correctly, that CORS headers reach a browser client, and
 * that importing the module does not open a port by itself.
 *
 * Port 0 + explicit close in a `finally` keeps the suite parallel-safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

/** Build an app on a free port; returns a `base` URL and a close function. */
async function startApp() {
  const dir = await mkdtemp(join(tmpdir(), 'oso-06-'));
  const cfg = loadConfig({ mode: 'dev', ledgerPath: join(dir, 'spend-log.jsonl') });
  const app = await createApp(cfg);
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    cfg,
    app,
    stop: async () => {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('server: /health reports the mode gate and network, so mock vs real is obvious', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'dev');
    assert.equal(body.gate, 'mock');
    assert.equal(body.network, 'hedera:testnet');
    assert.equal(body.split.artist, 9631);
    assert.equal(body.split.agent, 369);
  } finally {
    await stop();
  }
});

test('server: /.well-known/x402 advertises both prices and the right payees', async () => {
  const { base, cfg, stop } = await startApp();
  try {
    const res = await fetch(`${base}/.well-known/x402`);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.x402Version, 2);
    // the fan pays the artist; the agent pays itself
    assert.equal(body.resources['/ask'].payTo, cfg.accounts.artist);
    assert.equal(body.resources['/meter/v1/chat/completions'].payTo, cfg.accounts.compute);
    assert.equal(body.resources['/ask'].priceAtomic, '100000');
    assert.equal(body.resources['/meter/v1/chat/completions'].priceAtomic, '2000');
    // discovery must never leak a key
    assert.equal(JSON.stringify(body).includes('Bearer'), false);
  } finally {
    await stop();
  }
});

test('server: /split-preview computes the advertised split for any amount', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/split-preview?amount=1.00`);
    const body = (await res.json()) as Record<string, any>;
    // 1.00 USDC -> 0.9631 artist / 0.0369 agent
    assert.equal(body.totalAtomic, '1000000');
    assert.equal(body.artistAtomic, '963100');
    assert.equal(body.agentAtomic, '36900');
    assert.equal(body.artistPct, 96.31);
    assert.equal(body.agentPct, 3.69);
  } finally {
    await stop();
  }
});

test('server: GET /ask gets a 402 with CORS headers a browser can read the receipt from', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/ask?q=who+are+you`);
    assert.equal(res.status, 402);
    // the frontend is a browser app: without these two headers it cannot read
    // the settlement receipt even though the request succeeds
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(
      res.headers.get('access-control-expose-headers') ?? '',
      /x-payment-response/,
    );
    assert.ok(res.headers.get('payment-required'), 'v2 challenge header is present');
  } finally {
    await stop();
  }
});

test('server: OPTIONS is answered 204 for the browser preflight', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/ask`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-payment/);
  } finally {
    await stop();
  }
});

test('server: wrong method on the meter is a 405 that points at the right one', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/meter/v1/chat/completions`);
    assert.equal(res.status, 405);
    const body = (await res.json()) as Record<string, any>;
    assert.match(body.hint, /\/meter\/info/);
  } finally {
    await stop();
  }
});

test('server: an unknown path is a 404 that lists what does exist', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, any>;
    assert.ok(body.endpoints.includes('/ask'));
  } finally {
    await stop();
  }
});

test('server: a body over the 256 KB ceiling is a 400, not a crash', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.error, 'BAD_REQUEST');
    assert.match(body.message, /too large/);
  } finally {
    await stop();
  }
});

test('server: /ledger/recent is empty on a fresh run and totals are zero', async () => {
  const { base, stop } = await startApp();
  try {
    const res = await fetch(`${base}/ledger/recent`);
    const body = (await res.json()) as Record<string, any>;
    assert.deepEqual(body.entries, []);
    assert.equal(body.totals.totalUsd, 0);
    assert.equal(body.totals.calls, 0);
  } finally {
    await stop();
  }
});
