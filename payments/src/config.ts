/**
 * Config for the payments service.
 *
 * Everything comes from the environment; nothing is invented. The file has three
 * jobs and they are in this order on purpose:
 *
 *   1. Parse env into a typed `Config` (see `loadConfig`).
 *   2. Provide exact decimal <-> atomic conversion, because money must never be
 *      a float (`decimalToAtomic` / `atomicToDecimal`).
 *   3. Decide, from `PAYMENTS_MODE`, whether this process is allowed to move real
 *      funds. `dev` cannot; `live` refuses to start without the accounts it needs.
 *
 * Why "atomic": Hedera assets are integers. 1 USDC (6 decimals) is 1_000_000
 * atomic units. Every amount in this service is a `bigint` in atomic units, and
 * the conversion is the only place a decimal string is ever touched.
 */
import { readFileSync, existsSync } from 'node:fs';

/**
 * `dev`  — mock facilitator, mock settlement, local spend log. Zero credentials.
 * `live` — real x402 on Hedera testnet. Needs the artist + compute accounts.
 *
 * There is deliberately no `prod`: this repo is a hackathon testnet demo, and a
 * mode name that implies guaranteed safety would be dishonest.
 */
export type Mode = 'dev' | 'live';

/** The 96.31 / 3.69 revenue split, in basis points. Must total 10_000. */
export interface SplitBps {
  artist: number;
  agent: number;
}

/** The three spend ceilings enforced by the meter, in USD. */
export interface Budget {
  /** hard ceiling for the demo, across all calls */
  totalUsd: number;
  /** rolling ceiling, so a burst cannot drain the total in one minute */
  hourlyUsd: number;
  /** per-call ceiling, so one expensive prompt cannot set the hourly total */
  maxPerCallUsd: number;
}

export interface Config {
  mode: Mode;
  port: number;
  /** CAIP-2 style network id, e.g. `hedera:testnet` */
  network: string;
  facilitatorUrl: string;
  asset: { id: string; decimals: number };
  /** `artist` is where fan money lands; `compute` is the agent's 3.69% wallet */
  accounts: { artist: string; compute: string };
  agentPrivateKey?: string;
  hcsSpendTopicId?: string;
  split: SplitBps;
  /** prices in atomic units, already converted from the decimal env strings */
  prices: { askAtomic: bigint; meterAtomic: bigint };
  budget: Budget;
  /** the thing the meter resells: 0G Compute Router by default */
  upstream: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    /** `verified` asks 0G for a TEE attestation; see docs/RUNBOOK.md */
    trustMode: string;
  };
  stewardUrl: string;
  /** where the local spend ledger lives (jsonl). State, not source — gitignored. */
  ledgerPath: string;
}

/**
 * Minimal `.env` loader: no dependency, predictable, silent when the file is absent.
 *
 * Rules, all chosen so a typo is loud rather than silently ignored:
 *  - `KEY=value`, `#` comments, blank lines skipped
 *  - matching single or double quotes around a value are stripped
 *  - a real environment variable always wins over the file (`=== undefined` check),
 *    so `PORT=9000 npm start` overrides `.env` instead of the other way round
 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Treat an empty string as "not set" — an empty key is always a mistake, never a value. */
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};

/** Parse a numeric env var, or fall back. A non-numeric value throws instead of becoming NaN. */
const num = (k: string, fallback: number): number => {
  const v = env(k);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number, got ${JSON.stringify(v)}`);
  return n;
};

/**
 * "0.002" + 6 decimals -> 2000n.
 *
 * Refuses to round. If someone sets `PRICE_ASK_USDC=0.0000001` on a 6-decimal
 * asset, silently truncating to 0 would make the paywall free; throwing makes the
 * operator fix the config. Note the whole part may be absent ("`0.5`" or "`.5`").
 */
export function decimalToAtomic(value: string, decimals: number): bigint {
  const [whole, frac = ''] = value.trim().split('.');
  if (frac.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimals; would lose funds`);
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole || '0'}${padded}`);
}

/** Inverse of `decimalToAtomic`, for logs and UI. Always shows every decimal place. */
export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const s = (neg ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Build the effective config for this process.
 *
 * @param overrides applied *after* env, then validated — so a caller (a test)
 *        cannot slip an invalid value past the checks.
 * @throws if the split is not exactly 10000 bps, if the mode is unknown, or if
 *         `live` is requested without the account ids it needs.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const mode = (env('PAYMENTS_MODE') ?? 'dev') as Mode;
  if (mode !== 'dev' && mode !== 'live') {
    throw new Error(`PAYMENTS_MODE must be "dev" or "live", got ${JSON.stringify(mode)}`);
  }

  const decimals = num('HEDERA_ASSET_DECIMALS', 6);

  const base: Config = {
    mode,
    port: num('PORT', 8402),
    network: env('HEDERA_NETWORK') ?? 'hedera:testnet',
    facilitatorUrl: env('FACILITATOR_URL') ?? 'https://x402.org/facilitator',
    // 0.0.429274 is testnet USDC, taken from @x402/hedera's DEFAULT_ASSETS in the
    // shipped package — NOT from the docs, which said 0.0.6001. See PLAN.md.
    asset: { id: env('HEDERA_ASSET') ?? '0.0.429274', decimals },
    accounts: {
      artist: env('HEDERA_ARTIST_ACCOUNT_ID') ?? '',
      compute: env('HEDERA_COMPUTE_ACCOUNT_ID') ?? '',
    },
    agentPrivateKey: env('HEDERA_AGENT_PRIVATE_KEY'),
    hcsSpendTopicId: env('HCS_SPEND_TOPIC_ID'),
    split: {
      artist: num('SPLIT_ARTIST_BPS', 9631),
      agent: num('SPLIT_AGENT_BPS', 369),
    },
    prices: {
      askAtomic: decimalToAtomic(env('PRICE_ASK_USDC') ?? '0.10', decimals),
      meterAtomic: decimalToAtomic(env('PRICE_METER_USDC') ?? '0.002', decimals),
    },
    budget: {
      totalUsd: num('BUDGET_TOTAL_USD', 5),
      hourlyUsd: num('BUDGET_HOURLY_USD', 0.05),
      maxPerCallUsd: num('BUDGET_MAX_PER_CALL_USD', 0.01),
    },
    upstream: {
      baseUrl: (env('UPSTREAM_BASE_URL') ?? 'https://router-api.0g.ai/v1').replace(/\/+$/, ''),
      apiKey: env('UPSTREAM_API_KEY'),
      model: env('UPSTREAM_MODEL') ?? '0gm-1.0-35b-a3b',
      trustMode: env('UPSTREAM_TRUST_MODE') ?? 'verified',
    },
    stewardUrl: (env('STEWARD_URL') ?? 'http://localhost:8403').replace(/\/+$/, ''),
    ledgerPath: env('LEDGER_PATH') ?? 'data/spend-log.jsonl',
  };

  const cfg: Config = { ...base, ...overrides };

  // The split is the product promise: 96.31% artist, 3.69% agent, nothing to OSO.
  // A misconfigured total must stop the process, not ship a wrong split.
  if (cfg.split.artist + cfg.split.agent !== 10_000) {
    throw new Error(
      `split must total 10000 bps, got artist=${cfg.split.artist} + agent=${cfg.split.agent} = ${cfg.split.artist + cfg.split.agent}`,
    );
  }

  // dev keeps its zero-config promise: nothing settles on chain, so placeholder
  // accounts are honest here. They are never used for a real transfer — the
  // mock gate below never leaves the process.
  if (cfg.mode === 'dev') {
    if (!cfg.accounts.artist) cfg.accounts.artist = '0.0.5555';
    if (!cfg.accounts.compute) cfg.accounts.compute = '0.0.6666';
  }

  // live must fail fast and loudly, with the missing variable names, rather than
  // discovering the gap halfway through a demo.
  if (cfg.mode === 'live') {
    const missing = [
      ['HEDERA_ARTIST_ACCOUNT_ID', cfg.accounts.artist],
      ['HEDERA_COMPUTE_ACCOUNT_ID', cfg.accounts.compute],
    ].filter(([, v]) => !v);
    if (missing.length) {
      throw new Error(
        `PAYMENTS_MODE=live needs ${missing.map(([k]) => k).join(', ')} — see .env.example`,
      );
    }
  }

  return cfg;
}
