/**
 * Spend budget for the steward.
 *
 * ## Three ceilings, all checked before money moves
 *
 * | Ceiling | Catches |
 * |---|---|
 * | `maxUsdPerRequest` | one expensive prompt |
 * | `maxUsdPerHour` | a burst that would drain the total in a minute |
 * | `maxUsdTotal` | the demo's overall budget |
 *
 * The per-request check runs **before any network call**, so a request that cannot
 * be afforded never costs anything. That is the "spending controls for agents"
 * requirement, and it is also the **graceful-degradation trigger**: the steward turns
 * a refusal into a template reply instead of an error the fan can see.
 *
 * ## State is a file, not memory
 *
 * A restart must not forget what was spent — otherwise a mid-demo crash resets the
 * budget and the spend cap becomes decorative.
 *
 * > The budget file and the payments spend log are separate on purpose. This one is
 * > the agent's *own* view of what it has spent (it also counts tool turns that cost
 * > nothing on-chain); the payments ledger is the *billing* record. They can differ by
 * > design, and neither is allowed to be the other's source of truth.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BudgetCaps {
  maxUsdPerRequest: number;
  maxUsdPerHour: number;
  maxUsdTotal: number;
}

export interface BudgetEntry {
  at: string;
  // `template` entries are recorded at 0 cost so the file explains a free answer
  kind: 'inference' | 'tool' | 'template';
  spentUsd: number;
  note?: string;
}

/**
 * The answer to "can we afford this?".
 *
 * `scope` says **which** ceiling refused, so the caller can act intelligently: a
 * `request` refusal means "try a shorter/cheaper call", a `total`/`hourly` one means
 * "stop calling the model entirely".
 */
export type BudgetVerdict =
  | { ok: true; remainingUsd: number }
  | { ok: false; scope: 'request' | 'hourly' | 'total'; spentUsd: number; capUsd: number };

export class Budget {
  readonly caps: BudgetCaps;
  private readonly path: string;
  /** parsed cache; invalidated on every `record()` so totals cannot go stale */
  private cache: BudgetEntry[] | null = null;

  constructor(caps: BudgetCaps, path = process.env.BUDGET_LEDGER ?? 'data/budget.jsonl') {
    this.caps = caps;
    this.path = path;
  }

  /**
   * Read the ledger. A missing file is `[]` (first run) and a malformed line is
   * skipped with a warning — refusing to boot over one truncated line mid-demo would
   * be the wrong trade.
   */
  private async readAll(): Promise<BudgetEntry[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const entries: BudgetEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as BudgetEntry);
        } catch {
          console.warn(`[budget] skipping malformed line: ${line.slice(0, 80)}`);
        }
      }
      this.cache = entries;
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /** All-time and rolling-hour spend. `nowMs` is injectable so tests need not sleep. */
  async totals(
    nowMs = Date.now(),
  ): Promise<{ totalUsd: number; lastHourUsd: number; calls: number }> {
    const all = await this.readAll();
    const hourAgo = nowMs - 3_600_000;
    let total = 0;
    let hour = 0;
    for (const e of all) {
      const usd = Number(e.spentUsd);
      if (!Number.isFinite(usd)) continue;
      total += usd;
      if (Date.parse(e.at) >= hourAgo) hour += usd;
    }
    return { totalUsd: round6(total), lastHourUsd: round6(hour), calls: all.length };
  }

  /**
   * Can we afford `estimatedUsd`?
   *
   * @param estimatedUsd the pre-call estimate from the provider adapter.
   * @param overrides.maxUsd   a per-call cap from the request, tightening (or
   *                           loosening) the configured per-request ceiling.
   * @param overrides.nowMs    injectable clock for the hourly window.
   *
   * Checks run cheapest-first: the per-request ceiling needs no I/O, then the total,
   * then the hour. The first refusal wins so the reported `scope` is the most
   * specific one.
   */
  async check(
    estimatedUsd: number,
    overrides?: { maxUsd?: number; nowMs?: number },
  ): Promise<BudgetVerdict> {
    const perRequest = overrides?.maxUsd ?? this.caps.maxUsdPerRequest;
    if (estimatedUsd > perRequest) {
      return { ok: false, scope: 'request', spentUsd: estimatedUsd, capUsd: perRequest };
    }
    const t = await this.totals(overrides?.nowMs);
    if (t.totalUsd + estimatedUsd > this.caps.maxUsdTotal) {
      return { ok: false, scope: 'total', spentUsd: t.totalUsd, capUsd: this.caps.maxUsdTotal };
    }
    if (t.lastHourUsd + estimatedUsd > this.caps.maxUsdPerHour) {
      return { ok: false, scope: 'hourly', spentUsd: t.lastHourUsd, capUsd: this.caps.maxUsdPerHour };
    }
    return { ok: true, remainingUsd: round6(this.caps.maxUsdTotal - t.totalUsd) };
  }

  /** Append one spend line. `at` is optional so a test can backdate a fixture. */
  async record(entry: Omit<BudgetEntry, 'at'> & { at?: string }): Promise<void> {
    const full: BudgetEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as BudgetEntry;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    await appendFile(this.path, `${JSON.stringify(full)}\n`, 'utf8');
    // invalidate so the next check() sees this entry
    this.cache = null;
  }
}

/**
 * Round to 6 decimals (USDC precision).
 *
 * Applied only to **aggregates** compared against ceilings. Individual entries keep
 * their exact recorded value; this is a display/compare helper, not a rounding of
 * money that moves.
 */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
