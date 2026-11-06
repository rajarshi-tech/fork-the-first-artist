/**
 * Public entry point. Call `createSteward()` and nothing else:
 *
 * ```ts
 * import { createSteward } from './src/index.ts';
 * const steward = await createSteward();
 * const out = await steward.run({ provider: '0g', instruction: '...' });
 * ```
 *
 * ## What this file assembles, and why it is the only assembly point
 *
 * The steward needs five things that each know nothing about the others: a config, an
 * artist, a budget, a tool registry and a provider registry (optionally with a payer).
 * Wiring them in one place means a test can override any one of them without touching
 * the steward, and that there is exactly one definition of "the demo".
 *
 * ## The payer is created conditionally, and the condition is the safety story
 *
 * ```ts
 * transport === 'x402-meter' || process.env.HEDERA_AGENT_PRIVATE_KEY ? await createPayer() : undefined
 * ```
 *
 * No key and no metered transport means **no payer**, so the agent physically cannot pay
 * anything. It is not a flag that could be flipped; the wallet object does not exist.
 * The dev `mock` payer is only ever created when someone asks for the metered path.
 *
 * ## `forceFake` / `STEWARD_MODE=fake`
 *
 * Forces the fake provider so tests and the smoke script never touch a real vendor.
 * The registry still reports the real provider ids; it just serves them from the fake.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ArtistProfile } from './types.ts';
import { loadAgentConfig, loadDotEnv } from './config.ts';
import { Budget } from './budget.ts';
import { defaultTools } from './tools.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { Steward } from './steward.ts';
import { createPayer, type Payer } from './rails/payer.ts';
import { DEMO_ARTIST } from './demo-artist.ts';

export interface CreateStewardOptions {
  artistPath?: string;
  configPath?: string;
  /** tests: never touch a real provider */
  forceFake?: boolean;
  fetchImpl?: typeof fetch;
  payer?: Payer;
}

export { DEMO_ARTIST };

/**
 * Load the artist profile, falling back to `DEMO_ARTIST` when the file is absent.
 *
 * The merge order matters: `{ ...DEMO_ARTIST, ...raw }` means a partially-filled
 * `artist.json` inherits sane defaults rather than producing `undefined` fields. A
 * missing `consent` field therefore inherits `true` from the demo artist, which is
 * correct for the demo and is *explicitly* overridden in production configs.
 */
export async function loadArtist(path?: string): Promise<ArtistProfile> {
  const file = path ?? process.env.ARTIST_FILE ?? 'data/artist.json';
  if (!existsSync(file)) return DEMO_ARTIST;
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ArtistProfile>;
  return { ...DEMO_ARTIST, ...raw };
}

/**
 * Build a fully-wired steward.
 *
 * @param opts.artistPath - JSON file overriding `DEMO_ARTIST`
 * @param opts.configPath - provider config; defaults to the example config
 * @param opts.forceFake  - serve every provider from the fake adapter (tests, smoke)
 * @param opts.fetchImpl  - injected transport, so tests make no network calls
 * @param opts.payer      - injected wallet, so tests never sign anything
 */
export async function createSteward(opts: CreateStewardOptions = {}): Promise<Steward> {
  loadDotEnv();
  const config = loadAgentConfig(opts.configPath);
  const artist = await loadArtist(opts.artistPath);

  const transport = config.providers[config.default]?.transport ?? 'direct';
  const payer =
    opts.payer ??
    (transport === 'x402-meter' || process.env.HEDERA_AGENT_PRIVATE_KEY
      ? await createPayer()
      : undefined);

  const providers = new ProviderRegistry(config, {
    payer,
    fetchImpl: opts.fetchImpl,
    meterUrl: process.env.METER_URL,
    forceFake: opts.forceFake ?? process.env.STEWARD_MODE === 'fake',
  });

  return new Steward({
    config,
    artist,
    providers,
    tools: defaultTools(),
    budget: new Budget(config.budget),
    paymentsUrl: process.env.PAYMENTS_URL,
  });
}

// Re-exported so consumers need only one import path.
export { Steward } from './steward.ts';
export { Budget } from './budget.ts';
export { ToolRegistry, defaultTools } from './tools.ts';
export { ProviderRegistry } from './providers/registry.ts';
export { createPayer, type Payer } from './rails/payer.ts';
export { loadAgentConfig, providerAvailability } from './config.ts';
export { fencedData, sanitizeForPrompt, systemPrompt } from './fence.ts';
export { extractJson } from './steward.ts';
export * from './types.ts';
