/**
 * The 96.31 / 3.69 revenue split, in integer atomic units.
 *
 * This file exists because the split is the ethical claim of the project and it
 * must be arithmetic a reader can check in ten seconds, not a contract they have
 * to trust. Three rules hold:
 *
 *  1. **Never compute money in floats.** Everything is `bigint` atomic units.
 *  2. **Floor the agent share, give the remainder to the artist.** The two shares
 *     always sum to exactly the amount paid. A rounding unit can never be created
 *     or destroyed, and the direction of the rounding favours the artist.
 *  3. **Refuse a split that does not total 10000 bps.** A wrong split is a bug
 *     that must be loud, not a slightly-off payment.
 *
 * Where the "real" split happens on chain: one x402 `exact` payment is one
 * transfer to one `payTo` address, so it cannot be split during settlement.
 * The split therefore lives on the *asset* as an HTS fractional custom fee
 * (369/10000) — see `payments/scripts/create-tip-token.ts`. This module is the
 * same arithmetic done locally, so the ledger and the UI can show what the fee
 * will do, and tests can prove conservation without touching a network.
 */
import type { SplitBps } from './config.ts';

export interface Split {
  /** the amount the fan paid, atomic */
  total: bigint;
  /** goes to the artist's own account */
  artist: bigint;
  /** goes to the agent's compute wallet */
  agent: bigint;
}

/**
 * Split `total` atomic units into artist + agent shares.
 *
 * @param total amount paid, in atomic units. Must be >= 0.
 * @param bps   the split in basis points; `artist + agent` must be exactly 10000.
 * @returns     both shares; `artist + agent === total` always holds.
 * @throws      on a negative total or a split that does not total 10000.
 *
 * @example
 *   splitAtomic(100_000n, { artist: 9631, agent: 369 })
 *   // { total: 100000n, artist: 96310n, agent: 3690n }  // 0.10 USDC tip
 */
export function splitAtomic(total: bigint, bps: SplitBps): Split {
  if (total < 0n) throw new Error('total must be >= 0');
  if (bps.artist + bps.agent !== 10_000) {
    throw new Error(`split bps must total 10000, got ${bps.artist + bps.agent}`);
  }
  // Integer division floors for non-negative bigints, which is exactly the
  // rounding we want: the agent can only ever round DOWN.
  const agent = (total * BigInt(bps.agent)) / 10_000n;
  // Subtraction, not a second division: this is what guarantees exactness.
  const artist = total - agent;
  return { total, artist, agent };
}

/**
 * Sanity gate for the demo: a split must never create or destroy value.
 * Cheap enough to keep inside tests and the ledger writer.
 */
export function assertConserved(s: Split): void {
  if (s.artist + s.agent !== s.total) {
    throw new Error(`split not conserved: ${s.artist} + ${s.agent} != ${s.total}`);
  }
}

/**
 * Human summary for the UI and the pitch on a fixed `decimals` asset:
 * `"0.10 USDC -> 0.09631 artist / 0.00369 agent"`.
 *
 * Deliberately does not use `Number()` anywhere, so it cannot round a real amount.
 */
export function describeSplit(s: Split, decimals: number): string {
  const fmt = (v: bigint): string => {
    // pad to at least `decimals + 1` so there is always a whole part to slice off
    const t = v.toString().padStart(decimals + 1, '0');
    return `${t.slice(0, t.length - decimals)}.${t.slice(t.length - decimals)}`;
  };
  return `${fmt(s.total)} -> ${fmt(s.artist)} artist / ${fmt(s.agent)} agent`;
}
