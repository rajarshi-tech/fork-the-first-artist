/**
 * The demo artist — Shaka, the first human artist on these rails.
 *
 * This constant exists so tests and scripts do not each hard-code a profile, and so
 * there is exactly one place to change the demo. It mirrors `data/artist.json`, which
 * is what the running server loads; the file is the source of truth for a deployment
 * and this constant is the in-code equivalent for offline tests.
 *
 * Typed as a mutable `ArtistProfile` (not `as const`) so tests can spread it and
 * override a single field — e.g. `{ ...DEMO_ARTIST, consent: false }` to prove the
 * consent gate — without fighting literal types.
 *
 * `consent: true` is load-bearing: the steward refuses to answer for an artist whose
 * `consent` is `false` (`steward.ts` checks it before anything else). That is how the
 * team rule "consent first" is enforced in code rather than in policy.
 */
import type { ArtistProfile } from './types.ts';

export const DEMO_ARTIST: ArtistProfile = {
  name: 'Shaka',
  bio: 'Mumbai-based percussionist and vocalist. Built the Open Source Orchestra and is the first artist on these rails — fork him in one click.',
  songs: ['Monsoon Ragas', 'Bandra Night Bus', 'Salt on the Line'],
  ensName: 'shaka.oso.eth',
  hederaAccount: '0.0.0000',
  consent: true,
};
