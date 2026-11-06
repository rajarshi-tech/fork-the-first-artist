/**
 * Spend ledger + Hedera Consensus Service (HCS) audit log.
 *
 * ## One source of truth
 *
 * Every paid call appends **exactly one** line to `data/spend-log.jsonl`. Budget
 * totals are a `reduce` over that file. There is deliberately no second in-memory
 * set of books, because two sets of books can disagree and then nobody knows which
 * one the spend cap was enforced against.
 *
 * The recorder used to keep a summary in memory as well; that double-counted. It
 * was removed — this file is it.
 *
 * ## Where the lines end up
 *
 * | Mode | Line in `spend-log.jsonl` | `hcsTxId` |
 * |---|---|---|
 * | `dev`  | yes | `hcs-mock-<sha256 prefix>` — a stable synthetic id, clearly synthetic |
 * | `live` | yes | the real HCS topic message id, `"<txId>@<status>"` |
 *
 * Writing to HCS is Hedera's "topic as a tamper-evident audit log" bonus point, and
 * it is best-effort on purpose: an unhappy audit topic must never fail a payment
 * that has already settled. A failure is logged and recorded as `null`.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicToDecimal, type Config } from './config.ts';

/**
 * One paid call.
 *
 * `kind` distinguishes the two pricing paths so the hourly and total ceilings can
 * be computed against the right numbers:
 *  - `ask`      a fan paid the artist through the paywall
 *  - `meter`    the steward paid for its own inference
 *  - `template` a degraded answer; recorded so the ledger explains itself, but it
 *               must be written with `priceAtomic: '0'` because nothing was charged
 */
export interface SpendEntry {
  /** ISO-8601, always UTC. Every ceiling computation parses this. */
  at: string;
  kind: 'ask' | 'meter' | 'template';
  /** Hedera x402 settlement transaction id, or its mock equivalent */
  txId: string;
  /** atomic units as string — the authoritative amount for arithmetic */
  priceAtomic: string;
  /** the same amount in USD, for ceilings and display only */
  priceUsd: string;
  payer?: string;
  /** 0G router request id, captured from the `x_0g_trace`/`X-0G-Request-Id` response field */
  upstreamRequestId?: string;
  upstreamCostUsd?: string;
  /** 0G TEE attestation result; `null` means 0G did not report one */
  teeVerified?: boolean | null;
  model?: string;
  /** the 96.31% share, when the split was computed for this entry */
  artistAtomic?: string;
  /** the 3.69% share */
  agentAtomic?: string;
  /** HCS topic message id, or `null` when the audit write failed */
  hcsTxId?: string | null;
  /** free-text reason for a degraded or unusual entry */
  note?: string;
}

/** Aggregates used by the budget gate. `calls` counts every line, including templates. */
export interface Totals {
  totalUsd: number;
  lastHourUsd: number;
  calls: number;
}

export class SpendLog {
  private readonly cfg: Config;
  /** parsed ledger cache; invalidated on every append so totals cannot go stale */
  private cache: SpendEntry[] | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Read and parse the whole ledger.
   *
   * A missing file is `[]` (first run). A single malformed line is skipped rather
   * than aborting: the ledger is an append-only log written by an at-least-once
   * process, and refusing to boot over one truncated last line during a demo would
   * be the wrong trade. Every skip is reported on stderr so it is not silent.
   */
  private async readAll(): Promise<SpendEntry[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.cfg.ledgerPath, 'utf8');
      const entries: SpendEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as SpendEntry);
        } catch {
          console.warn(`[ledger] skipping malformed line: ${line.slice(0, 80)}`);
        }
      }
      this.cache = entries;
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /**
   * Append one paid call and return the stored entry (with its `at` and `hcsTxId`).
   *
   * @param entry everything except `at`; a caller may supply `at` to backdate a
   *              test fixture.
   */
  async append(entry: Omit<SpendEntry, 'at'> & { at?: string }): Promise<SpendEntry> {
    const full: SpendEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as SpendEntry;

    // Audit first so the stored line already carries its HCS id. A failure here is
    // swallowed on purpose: the payment has already settled, and losing the book
    // entry would be worse than losing the audit pointer to it.
    full.hcsTxId = await this.submitToHcs(full).catch((err: unknown) => {
      console.warn(`[hcs] submit failed: ${(err as Error).message}`);
      return null;
    });

    await mkdir(dirname(this.cfg.ledgerPath), { recursive: true }).catch(() => {});
    await appendFile(this.cfg.ledgerPath, `${JSON.stringify(full)}\n`, 'utf8');
    // invalidate so the next totals() sees this line
    this.cache = null;
    return full;
  }

  /**
   * Publish the entry to the HCS spend topic.
   *
   * @returns a topic message id, or a `hcs-mock-…` synthetic id in dev mode.
   * @throws  when live mode is missing a key or the SDK call fails — the caller
   *          catches and records `null`.
   */
  private async submitToHcs(entry: SpendEntry): Promise<string | null> {
    if (this.cfg.mode === 'dev' || !this.cfg.hcsSpendTopicId) {
      // Synthetic, but derived from the entry, so the same entry always yields the
      // same id and a test can assert on it deterministically.
      return `hcs-mock-${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)}`;
    }

    // Dynamic import: dev mode must run with the Hedera SDK absent (see step 03).
    const { Client, PrivateKey, TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');
    if (!this.cfg.agentPrivateKey) throw new Error('HEDERA_AGENT_PRIVATE_KEY required for HCS');

    // `Client.forName` wants `testnet`/`mainnet`, not the CAIP-2 `hedera:testnet`.
    const client = Client.forName(this.cfg.network.replace('hedera:', '')) as never as {
      setOperator(id: string, key: unknown): unknown;
    };
    client.setOperator(
      this.cfg.accounts.compute,
      PrivateKey.fromStringECDSA(this.cfg.agentPrivateKey),
    );

    const resp = await new TopicMessageSubmitTransaction()
      .setTopicId(this.cfg.hcsSpendTopicId)
      .setMessage(JSON.stringify(entry))
      .execute(client as never);
    const receipt = await resp.getReceipt(client as never);
    return `${resp.transactionId.toString()}@${receipt.status.toString()}`;
  }

  /**
   * All-time and rolling-hour spend.
   *
   * @param now injectable timestamp so the hourly-window test does not have to
   *            sleep for an hour.
   */
  async totals(now = Date.now()): Promise<Totals> {
    const all = await this.readAll();
    const oneHourAgo = now - 60 * 60 * 1000;
    let total = 0;
    let lastHour = 0;
    for (const e of all) {
      const usd = Number(e.priceUsd);
      if (!Number.isFinite(usd)) continue;
      total += usd;
      if (Date.parse(e.at) >= oneHourAgo) lastHour += usd;
    }
    return { totalUsd: round6(total), lastHourUsd: round6(lastHour), calls: all.length };
  }

  /** Newest-first slice, for the demo output and any future admin page. */
  async recent(n = 20): Promise<SpendEntry[]> {
    const all = await this.readAll();
    return all.slice(-n).reverse();
  }
}

/**
 * Round to 6 decimals (USDC precision).
 *
 * Used only for the *aggregate* numbers shown to humans and compared to ceilings.
 * The per-entry `priceAtomic` string is the authoritative value and is never
 * rounded — this is why the two are stored separately.
 */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Format an atomic amount for display, e.g. `2000n` on 6 decimals → `"0.002000"`. */
export function describePrice(atomic: bigint, decimals: number): string {
  return atomicToDecimal(atomic, decimals);
}
