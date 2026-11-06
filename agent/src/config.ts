/**
 * Config loading + validation.
 *
 * No schema library on purpose: the config is small, and **the error messages are
 * the documentation**. Every failure names the file, the provider and the field, so
 * a teammate can fix it without reading this code.
 *
 * Two rules that shape everything here:
 *
 * 1. **A fresh clone must boot.** `config/providers.json` is gitignored (it may
 *    legitimately differ per machine), so the loader falls back to the checked-in
 *    `config/providers.example.json`.
 * 2. **A wrong config must stop the process, not the demo.** Unknown capabilities,
 *    a dangling `default`, a missing `baseUrl` — all throw at load time.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { AgentConfig, Capability, ProviderConfig, ProviderId } from './types.ts';

/** Minimal `.env` reader: no dependency, silent when absent, real env always wins. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // `=== undefined` so `PORT=9000 npm start` overrides .env, not the reverse
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const CAPS: Capability[] = ['tools', 'json', 'vision', 'stream'];

/**
 * Load and validate the provider registry.
 *
 * @param path `PROVIDER_CONFIG` or `config/providers.json`. When missing, the
 *             `.example.json` sibling is used instead.
 * @throws with the file path and the offending provider/field named.
 *
 * Validation order matters: the structure is checked before the generation and
 * budget values are merged from env, so a structural error is reported first.
 */
export function loadAgentConfig(
  path = process.env.PROVIDER_CONFIG ?? 'config/providers.json',
): AgentConfig {
  if (!existsSync(path)) {
    // fall back to the checked-in example so a fresh clone always boots
    const fallback = path.replace(/\.json$/, '.example.json');
    if (!existsSync(fallback)) throw new Error(`no provider config at ${path} or ${fallback}`);
    path = fallback;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;

  if (!parsed.providers || typeof parsed.providers !== 'object') {
    throw new Error(`${path}: missing "providers"`);
  }
  if (!parsed.providers[parsed.default]) {
    throw new Error(`${path}: default provider "${parsed.default}" is not in providers`);
  }

  for (const [id, p] of Object.entries(parsed.providers)) {
    // rail entries describe money, not a model, so the model checks do not apply
    if (p.kind === 'rail') continue;
    if (!p.baseUrl) throw new Error(`${path}: provider ${id} needs baseUrl`);
    if (!p.defaultModel) throw new Error(`${path}: provider ${id} needs defaultModel`);
    for (const cap of p.capabilities ?? []) {
      // a typo'd capability would silently make a feature "unsupported" forever
      if (!CAPS.includes(cap)) {
        throw new Error(`${path}: provider ${id} has unknown capability ${cap}`);
      }
    }
  }

  const g = parsed.generation ?? { temperature: 0.4, maxTokens: 400, maxToolTurns: 4 };
  const b = parsed.budget ?? { maxUsdPerRequest: 0.002, maxUsdPerHour: 0.05, maxUsdTotal: 5 };
  // a non-positive per-request cap would refuse every single call; that is a
  // config mistake, not a policy setting
  if (!(b.maxUsdPerRequest > 0)) throw new Error(`${path}: budget.maxUsdPerRequest must be > 0`);

  return {
    ...parsed,
    // env wins over the file, so an operator can tighten a budget without editing
    // a committed config
    generation: {
      temperature: envNum('GENERATION_TEMPERATURE', g.temperature),
      maxTokens: envNum('GENERATION_MAX_TOKENS', g.maxTokens),
      maxToolTurns: g.maxToolTurns,
    },
    budget: {
      maxUsdPerRequest: envNum('BUDGET_PER_REQUEST_USD', b.maxUsdPerRequest),
      maxUsdPerHour: envNum('BUDGET_HOURLY_USD', b.maxUsdPerHour),
      maxUsdTotal: envNum('BUDGET_TOTAL_USD', b.maxUsdTotal),
    },
  };
}

/** Numeric env var, or the fallback. A non-numeric value throws rather than becoming NaN. */
function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * Has this provider got what it needs to actually run?
 *
 * The `x402-meter` transport is treated as usable without a key **because the meter
 * holds the upstream key** — the agent only needs a wallet to pay it. That is the
 * whole architectural point: the agent never holds a vendor API key.
 *
 * When there is no wallet key it is still "usable", with a reason, because dev mode
 * pays with the mock gate. The reason string is what `/health` shows so nobody
 * mistakes a mock run for a real one.
 */
export function providerAvailability(
  cfg: ProviderConfig,
): { usable: boolean; reason?: string } {
  if (cfg.transport === 'x402-meter') {
    return {
      usable: true,
      reason: process.env.HEDERA_AGENT_PRIVATE_KEY ? undefined : 'no wallet key: dev/mock payment',
    };
  }
  if (!cfg.envKey) return { usable: true };
  const v = process.env[cfg.envKey];
  return v ? { usable: true } : { usable: false, reason: `${cfg.envKey} is not set` };
}

/** The inference providers configured (rail entries excluded). */
export function providerIds(cfg: AgentConfig): ProviderId[] {
  return Object.entries(cfg.providers)
    .filter(([, p]) => p.kind === 'inference')
    .map(([id]) => id as ProviderId);
}
