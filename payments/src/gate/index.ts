/**
 * Gate factory — the single entry point the rest of the service imports.
 *
 * The `import()` inside is the load-bearing line of this whole package:
 *
 *   - `dev`  → returns the mock gate, `hedera.ts` is never loaded, so `@x402/*`
 *              and `@hiero-ledger/sdk` need not be installed.
 *   - `live` → loads `hedera.ts` on demand.
 *
 * That is what lets step 02's `optionalDependencies` promise be true rather than
 * aspirational: a fresh clone with `--omit=optional` still runs `npm test` and
 * `PAYMENTS_MODE=dev npm start`.
 */
import type { Config } from '../config.ts';
import type { Gate } from './types.ts';
import { createMockGate } from './types.ts';

export type {
  Challenge,
  Gate,
  PaymentRequirementsView,
  SettleResult,
  VerifyResult,
} from './types.ts';
export { createMockGate } from './types.ts';

/**
 * Async **on purpose** — a synchronous factory could not lazily import the live
 * gate, and then dev mode would need the chain SDKs at module load.
 *
 * @param cfg validated config; `cfg.mode` decides which gate is returned.
 */
export async function createGate(cfg: Config): Promise<Gate> {
  if (cfg.mode !== 'live') return createMockGate(cfg);
  const { createHederaGate } = await import('./hedera.ts');
  return createHederaGate(cfg);
}
