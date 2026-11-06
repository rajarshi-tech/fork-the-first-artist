/**
 * Public surface of `@oso/payments`.
 *
 * The steward service imports from here, which is why this file exists at all: it
 * is the contract between `payments/` and `agent/`. Keeping the export list narrow
 * and explicit is what allows either package to be re-implemented without the
 * other noticing.
 *
 * Not exported on purpose: the gate internals and the ledger's parsing helpers.
 * They are implementation, and widening this surface would make the two packages
 * harder to separate rather than easier.
 */
export {
  loadConfig,
  loadDotEnv,
  atomicToDecimal,
  decimalToAtomic,
  type Config,
} from './config.ts';
export { splitAtomic, assertConserved, describeSplit, type Split } from './split.ts';
export { SpendLog, type SpendEntry, type Totals } from './spend-log.ts';
export {
  createGate,
  createMockGate,
  type Gate,
  type PaymentRequirementsView,
} from './gate/index.ts';
export { METER_PATH, meterInfo, handleMeter, type MeterDeps } from './meter.ts';
export { ASK_PATH, handleAsk, type PaywallDeps, type StewardReply } from './paywall.ts';
export { createApp, start, type App } from './server.ts';
