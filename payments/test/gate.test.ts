/**
 * Gate tests (step 03).
 *
 * These only exercise the MOCK gate — which is the point: the mock must be good
 * enough that the *shape* of the protocol is proven here without a network. The
 * assertions check the x402 v2 wire format literally (field names, the
 * `payment-required` header, base64 encoding) because a client on the other end
 * parses those names exactly.
 *
 * The live gate is asserted only for the one property this step can prove offline:
 * that importing the gate factory in dev mode does not pull in the chain SDKs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { createGate, createMockGate } from '../src/gate/index.ts';
import type { Gate, PaymentRequirementsView } from '../src/gate/index.ts';

const cfg = loadConfig({ mode: 'dev' });

test('gate: dev mode returns the mock gate, and no chain SDK is needed', async () => {
  const gate = await createGate(cfg);
  assert.equal(gate.kind, 'mock');
});

test('gate: 402 carries the x402 v2 body and the payment-required header', async () => {
  const gate: Gate = createMockGate(cfg);
  const challenge = await gate.challenge({
    resource: '/ask',
    amountAtomic: 100_000n,
    payTo: '0.0.5555',
    description: 'ask the steward',
  });

  assert.equal(challenge.status, 402);
  assert.equal(challenge.body.x402Version, 2);
  assert.equal(challenge.body.accepts.length, 1);

  const req = challenge.body.accepts[0]!;
  // field names are the wire format from @x402/core@2.30.0 — do not rename
  assert.equal(req.scheme, 'exact');
  assert.equal(req.network, 'hedera:testnet');
  assert.equal(req.amount, '100000');
  assert.equal(req.asset, cfg.asset.id);
  assert.equal(req.payTo, '0.0.5555');
  assert.equal(req.resource, '/ask');
  assert.equal(req.maxTimeoutSeconds, 180);
  // amount is a string, never a number, so JSON cannot lose precision
  assert.equal(typeof req.amount, 'string');

  // the header must decode back to the same body
  const header = challenge.headers['payment-required']!;
  assert.equal(header !== undefined, true);
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.deepEqual(decoded.accepts, challenge.body.accepts);
  // settlement metadata must never be cached by a shared proxy
  assert.equal(challenge.headers['cache-control'], 'no-store');
});

test('gate: dev challenges are explicitly labelled as mock, not settled', async () => {
  const gate = createMockGate(cfg);
  const challenge = await gate.challenge({
    resource: '/ask',
    amountAtomic: 1n,
    payTo: '0.0.5555',
  });
  assert.equal(challenge.body.accepts[0]!.extra?.devMock, true);
  assert.match(challenge.body.error ?? '', /nothing settles on chain/);
});

test('gate: verify refuses a missing header instead of charging nobody', async () => {
  const gate = createMockGate(cfg);
  const requirements = (await gate.challenge({ resource: '/ask', amountAtomic: 1n, payTo: '0.0.5555' }))
    .body.accepts[0]!;
  const v = await gate.verify({ requirements });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /missing X-PAYMENT/);
});

test('gate: verify rejects, settle succeeds, and mock tx ids are never mistaken for real ones', async () => {
  const gate = createMockGate(cfg);
  const requirements: PaymentRequirementsView = (
    await gate.challenge({ resource: '/ask', amountAtomic: 100_000n, payTo: '0.0.5555' })
  ).body.accepts[0]!;

  const v = await gate.verify({ paymentHeader: 'payer=0.0.1234', requirements });
  assert.equal(v.ok, true);
  assert.equal(v.payer, '0.0.1234');

  const s = await gate.settle({ handle: v.handle, requirements });
  assert.equal(s.success, true);
  // the `mock-` prefix is load-bearing: it can never be mistaken for HashScan proof
  assert.match(s.txId ?? '', /^mock-/);
  assert.equal(s.network, cfg.network);
});

test('gate: payTo falls back to the configured artist account, never to us', async () => {
  const gate = createMockGate(cfg);
  const challenge = await gate.challenge({ resource: '/ask', amountAtomic: 1n, payTo: '' });
  assert.equal(challenge.body.accepts[0]!.payTo, cfg.accounts.artist);
});
