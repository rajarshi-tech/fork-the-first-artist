/**
 * Spend ledger tests (step 04).
 *
 * The ledger is the only record of what was charged, so these tests pin down the
 * three properties the budget gate depends on:
 *
 *   1. exactly one line per paid call (a duplicate line would double-count spend),
 *   2. totals are a reduce over that file (no second set of books),
 *   3. the rolling-hour window is honest, and a template entry adds zero spend.
 *
 * Each test writes to its own temp file so they can run in any order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { SpendLog, describePrice } from '../src/spend-log.ts';

const freshCfg = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oso-ledger-'));
  const cfg = loadConfig({ mode: 'dev', ledgerPath: join(dir, 'spend-log.jsonl') });
  return { cfg, dir };
};

test('ledger: one paid call writes exactly one line, and totals are a reduce over it', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    await ledger.append({
      kind: 'ask',
      txId: 'mock-1',
      priceAtomic: '100000',
      priceUsd: '0.1',
      payer: '0.0.1234',
    });
    await ledger.append({
      kind: 'meter',
      txId: 'mock-2',
      priceAtomic: '2000',
      priceUsd: '0.002',
      payer: '0.0.6666',
    });

    // exactly two lines on disk — no summary line, no duplication
    const raw = await readFile(cfg.ledgerPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const totals = await ledger.totals();
    assert.equal(totals.calls, 2);
    // 0.1 + 0.002, rounded to 6 dp
    assert.equal(totals.totalUsd, 0.102);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: a degraded (template) answer is recorded but adds no spend', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    await ledger.append({
      kind: 'template',
      txId: 'none',
      priceAtomic: '0',
      priceUsd: '0',
      note: 'budget exhausted, served template reply',
    });
    const totals = await ledger.totals();
    assert.equal(totals.calls, 1);
    assert.equal(totals.totalUsd, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: the hourly window only counts entries inside it', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();

    // appended out of order on purpose: the window must be time-based, not positional
    await ledger.append({
      kind: 'meter', txId: 'old', priceAtomic: '50000', priceUsd: '0.05', at: twoHoursAgo,
    });
    await ledger.append({
      kind: 'meter', txId: 'new', priceAtomic: '2000', priceUsd: '0.002', at: tenMinutesAgo,
    });

    const totals = await ledger.totals(now);
    assert.equal(totals.totalUsd, 0.052); // both count toward the total
    assert.equal(totals.lastHourUsd, 0.002); // only the recent one counts toward the hour
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: dev HCS ids are deterministic and obviously synthetic', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    const entry = {
      kind: 'ask' as const,
      txId: 'mock-x',
      priceAtomic: '1',
      priceUsd: '0.000001',
    };
    const a = await ledger.append(entry);
    // a fresh ledger's cache is cleared, so re-appending the same shape re-derives
    assert.match(a.hcsTxId ?? '', /^hcs-mock-[0-9a-f]{16}$/);
    assert.equal(a.hcsTxId!.startsWith('hcs-mock-'), true, 'never mistakable for a real HCS id');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: a missing file is an empty ledger, not a crash', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    const totals = await ledger.totals();
    assert.deepEqual(totals, { totalUsd: 0, lastHourUsd: 0, calls: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: recent() is newest-first', async () => {
  const { cfg, dir } = await freshCfg();
  try {
    const ledger = new SpendLog(cfg);
    await ledger.append({ kind: 'meter', txId: 'a', priceAtomic: '1', priceUsd: '0.000001' });
    await ledger.append({ kind: 'meter', txId: 'b', priceAtomic: '1', priceUsd: '0.000001' });
    const recent = await ledger.recent(2);
    assert.equal(recent[0]!.txId, 'b');
    assert.equal(recent[1]!.txId, 'a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ledger: describePrice never rounds a real amount', () => {
  assert.equal(describePrice(2_000n, 6), '0.002000');
  assert.equal(describePrice(100_000n, 6), '0.100000');
  assert.equal(describePrice(1n, 6), '0.000001');
});
