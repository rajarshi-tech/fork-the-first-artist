# Build log — chronology

Append-only. Newest entry at the bottom of each table.
Author of all rows in this session: **Rajarshi**.

## Session log

| When (IST) | Step | Author | Event | Commit | Tests |
|---|---|---|---|---|---|
| 2026-11-06 14:10 | — | Rajarshi | Backed up original squashed commit `12857fa` to `.backup/` (git bundle + patch + worktree) | — | — |
| 2026-11-06 14:12 | — | Rajarshi | `git reset --hard 6fe2eec` — repo back to skeleton, remote branch to be force-pushed at the end | — | — |
| 2026-11-06 14:15 | 00 | Rajarshi | Created `docs/build-log/` (PLAN, README, LOG, `steps/`) — plan written before any code | — | — |
| 2026-11-06 14:22 | 01 | Rajarshi | Root `package.json` (script dispatcher, `engines.node>=22.18`), `.gitattributes` (LF policy), `.gitignore` (`!.env.example` negation, runtime ledgers, `.backup/`) | `chore(repo): root scripts, ignore rules, line-ending policy` | none yet |

## Who changed what — summary table

| Folder | Owner of every commit in this series | Notes |
|---|---|---|
| root (`package.json`, `.gitignore`, `.gitattributes`) | Rajarshi | dispatcher only, no deps |
| `payments/` | Rajarshi | x402 rail, Hedera |
| `agent/` | Rajarshi | steward, 0G |
| `docs/build-log/` | Rajarshi | this log |
| `ens/`, `frontend/` | **teammates — NOT touched by this series** | skeleton READMEs only |
| 2026-11-06 14:30 | 01 | Rajarshi | Force-pushed branch `feat/agents-payments-provider-abstraction` → remote now points at `ce6a9dd` (old squash `12857fa` gone from remote, preserved in `.backup/`) | — | — |
| 2026-11-06 14:31 | 01 | Rajarshi | Opened PR **#3** against teammate fork `princekeshri00/fork-the-first-artist` → https://github.com/princekeshri00/fork-the-first-artist/pull/3 | — | — |

## PR strategy

GitHub allows **one open PR per head branch**. To get one PR per step, each step gets its own branch and its own PR, stacked:

```
main (6fe2eec)
 └── step/01-root-scaffolding          → PR #1  (base: main)
      └── step/02-payments-config-money → PR #2  (base: step/01-root-scaffolding)
           └── step/03-...              → PR #3  (base: step/02-...)
```

Reviewing PR #N therefore shows exactly that step's diff, because its base is the previous step. Merging all of them into `main` reproduces the full series.

`feat/agents-payments-provider-abstraction` is also kept as one monolithic branch with all steps, and is what the cross-fork PR
[**princekeshri00#3**](https://github.com/princekeshri00/fork-the-first-artist/pull/3) targets — that is the PR the teammate merges.

| Step | Branch | PR (own fork) | Opened |
|---|---|---|---|
| 01 | `step/01-root-scaffolding` | [#1](https://github.com/rajarshi-tech/fork-the-first-artist/pull/1) | 2026-11-06 14:52 |
| 02 | `step/02-payments-config-money` | [#2](https://github.com/rajarshi-tech/fork-the-first-artist/pull/2) | 2026-11-06 14:54 |
| 2026-11-06 14:40 | 02 | Rajarshi | `payments/` scaffold: package.json (3 chain deps optional), tsconfig (typecheck only, no emit), `.env.example` with the verified `0.0.429274` testnet USDC id | — | — |
| 2026-11-06 14:44 | 02 | Rajarshi | `src/config.ts` (env → typed Config, `decimalToAtomic` refuses to round, `live` fails fast on missing accounts) + `src/split.ts` (floor agent / subtract to artist, so shares always sum exactly) | `feat(payments): config and exact atomic money math` | 6/6 pass, tsc clean |
| 2026-11-06 14:52 | 01 | Rajarshi | Branch `step/01-root-scaffolding` + own-fork PR **#1** (base `main`) | — | — |
| 2026-11-06 14:54 | 02 | Rajarshi | Branch `step/02-payments-config-money` + own-fork PR **#2** (base `step/01-root-scaffolding`, stacked) | — | — |
| 2026-11-06 15:05 | 03 | Rajarshi | `gate/types.ts` (Gate contract + dev mock producing the real x402-v2 shape), `gate/hedera.ts` (live facilitator client: /supported, /verify, /settle), `gate/index.ts` (async factory so the live SDK loads lazily) | — | — |
| 2026-11-06 15:12 | 03 | Rajarshi | 6 gate tests added. Proved the optional-dependency claim empirically: `npm install --omit=optional` → no `@x402`, all 12 tests still pass | `feat(payments): payment gate interface, dev mock and Hedera/x402 implementation` | 12/12 pass, tsc clean |
| 2026-11-06 15:24 | 04 | Rajarshi | `spend-log.ts` — one line per paid call, totals as a reduce (the old in-memory summary double-counted spend and was removed), deterministic `hcs-mock-` ids, malformed lines skipped with a warning | — | — |
| 2026-11-06 15:26 | 04 | Rajarshi | `http.ts` — six small helpers, `no-store` by default, 256 KB body ceiling, `header()` returns undefined not `''` | — | — |
| 2026-11-06 15:30 | 04 | Rajarshi | 7 ledger tests. The hourly test appends an older entry after a newer one, so it fails if the window is positional instead of timestamp-based | `feat(payments): spend ledger, HCS audit trail and http helpers` | 19/19 pass, tsc clean |
| 2026-11-06 15:45 | 05 | Rajarshi | `paywall.ts` — `/ask`, settle() strictly last, 422 for refusal vs 502 for outage, `payTo` from ENS record, `proof` binds paymentTxId ↔ upstream requestId | — | — |
| 2026-11-06 15:47 | 05 | Rajarshi | `meter.ts` — `/meter/v1/chat/completions` paid to the agent's own wallet, budget check BEFORE the 402, 403 SPEND_CAP_EXCEEDED (never a 402 we cannot serve), offline dev stand-in labelled `dev-` | — | — |
| 2026-11-06 15:52 | 05 | Rajarshi | 11 endpoint tests. "Never charged for a failure" is asserted with a settle()-call **counter**, not just the HTTP status | `feat(payments): paywall and pay-per-call inference meter` | 30/30 pass, tsc clean |
| 2026-11-06 16:05 | 06 | Rajarshi | `server.ts` — 8 routes, `createApp()` (no listen) split from `start()`, import guard so importing the module never opens a port, CORS exposes `x-payment-response` for the browser frontend | — | — |
| 2026-11-06 16:07 | 06 | Rajarshi | `index.ts` — explicit narrow contract between `payments/` and `agent/` | — | — |
| 2026-11-06 16:12 | 06 | Rajarshi | 9 server tests on port 0 + a real boot check: `node src/server.ts` → `/health` 200, `/ask` 402, `/.well-known/x402` shows both payees | `feat(payments): http server wiring the paywall, meter and discovery routes` | 39/39 pass, tsc clean |
| 2026-11-06 16:22 | 07 | Rajarshi | `scripts/create-tip-token.ts` — HTS fractional fee 369/10000 so the split happens on the asset (an x402 exact payment is one transfer to one payTo, so it cannot be split in-protocol) | — | — |
| 2026-11-06 16:26 | 07 | Rajarshi | `payments/README.md` — design decisions with their failure modes + the honest status table ("written, never executed") | `docs(payments): README with status table; feat(payments): HTS split token script` | 39/39 pass, tsc clean |
| 2026-11-06 16:45 | 08 | Rajarshi | `agent/` scaffold + `types.ts` — the requested provider abstraction: one `steward.run({provider,...})` call, one envelope back, closed `ErrorCode` union and discriminated `AgentResult` | — | — |
| 2026-11-06 16:47 | 08 | Rajarshi | `config.ts` (errors name file+provider+field, fresh clone falls back to `.example.json`) + `providers/{openai-compatible,anthropic,google,fake,registry}.ts` + `rails/payer.ts` | — | — |
| 2026-11-06 16:55 | 08 | Rajarshi | 17 tests. Two failed on first run because my test assumptions were stale (not code bugs): direct transport reads `x_0g_trace` not the header, fake ids are `fake-req-`. Both tests corrected and a meter-path binding test added | `feat(agent): provider-agnostic interface, config-driven registry and four adapters` | 17/17 pass, tsc clean |
| 2026-11-06 17:10 | 09 | Rajarshi | `fence.ts` — sanitise before fencing, so a bio containing the fence token cannot close the block early; attack text is kept as data, never deleted | — | — |
| 2026-11-06 17:12 | 09 | Rajarshi | `budget.ts` — three ceilings checked before any network call, `scope` in the verdict so the caller can degrade correctly, state in a file so a crash cannot reset the cap | — | — |
| 2026-11-06 17:18 | 09 | Rajarshi | 15 tests incl. both fence-escape attacks, the positional-vs-timestamp hourly window, and restart durability. 32/32 total | `feat(agent): prompt fencing against injection, and the three-ceiling spend budget` | 32/32 pass, tsc clean |
