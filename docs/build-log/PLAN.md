# Build Log — plan for `agent/` + `payments/`

*Owner of this work: **Rajarshi** (the only author of every commit in this log for this session).*
*Hackathon: ETHGlobal Mumbai 2026. Repo: `rajarshi-tech/fork-the-first-artist` (a fork of the fork, see [CONTEXT](#context--why-this-log-exists)).*

---

## Context — why this log exists

This project follows a **continuation-track layout**:

```
owner (Shaka)            → empty repo
        └── teammate 2   → forked it  ← PRs land HERE
                └── us   → forked the fork  ← we commit + PR from here
```

The owner then re-implements our diff into his real repository with his own agent, so **the diff has to be readable step by step**, not one 51-file squash. That is the reason for this rebuild:

1. The first attempt landed as a single commit (`12857fa`, 51 files). It was correct and green, but unreviewable and impossible to cherry-pick.
2. It is being **undone and redone as a series of small, self-contained, individually-tested commits**, each with its own PR.
3. Every step is documented here *before* it is committed.

Backup of the original squashed commit, kept out of git:

| Artifact | Path |
|---|---|
| Full git bundle of every ref | `.backup/pre-undo-12857fa.bundle` |
| The whole commit as a mailable patch | `.backup/12857fa-full.patch` |
| Checked-out tree of `12857fa` | `.backup/orig/` (git worktree) |

---

## Scope

We own **two folders only**:

| Folder | What it is | Sponsor |
|---|---|---|
| `agent/` | The steward — one interface over five model providers, with fenced artist data, a budget gate and a degradation ladder | **0G** |
| `payments/` | The x402 rail — fan pays the artist, the steward pays its own inference, 96.31 / 3.69 split | **Hedera** (x402 track) |

`ens/` and `frontend/` belong to teammates and are **not touched**.

---

## Design rules we are held to (from `docs/PLAN.md`)

| Rule | Where it shows up in code |
|---|---|
| Agent collects, artist holds | `payments/src/paywall.ts` — `payTo` is the artist account |
| Consent first | agent answers only from `agent/data/artist.json`, no scraping |
| Zero cut, no token | split is 9631/369, remainder to the artist, nothing to OSO |
| Spend cap on compute | `agent/src/budget.ts`, three ceilings, checked **before** any network call |
| Testnet for the demo | `HEDERA_NETWORK=hedera:testnet` |
| Open source, AI help disclosed | this log; `AI help disclosed` in READMEs |

---

## Ground truth we build against (verified, not remembered)

Checked in the previous session against the installed packages — carried over:

| Fact | Value | How it was established |
|---|---|---|
| testnet USDC asset id | `0.0.429274` (6 decimals) | `@x402/core` `DEFAULT_ASSETS` in the shipped dist, not the docs (`docs` said `0.0.6001`) |
| x402 wire version | `2` | `paymentRequiredSchema` in `@x402/core` |
| 402 challenge header | `PAYMENT-REQUIRED: base64(JSON)` | `encodePaymentRequiredHeader` in the shipped client |
| proof-of-payment header | `X-PAYMENT: base64(JSON)` | `encodePaymentSignatureHeader` |
| facilitator verify/settle | `POST {url}/verify`, `POST {url}/settle` with `{paymentPayload, paymentRequirements}` | `HTTPFacilitatorClient` source |
| settle response | `{success, errorReason?, errorMessage?, payer?, transaction, network}` | `settleResponseSchema` |
| spend controls | built into `x402Client.setSpendControls` | `x402Client` d.ts |
| Node version | 24.11.1, npm 11.19.0 | `node -v` |
| Hedera SDK | `@hiero-ledger/sdk@2.90.1`, `@x402/core@2.30.0`, `@x402/hedera@2.30.0` | `npm view` |

Consequence: `@x402/*` and the Hedera SDK are **optionalDependencies, lazily imported** — dev mode runs with none of them installed.

---

## The step series

Every row is one commit and one PR. Each step must, on its own, leave the tree typechecking and its tests passing.

| # | Commit | Touches | Proves |
|---|---|---|---|
| 01 | `chore(repo): root package.json, gitignore, gitattributes` | root | workspace scripts, `.env.example` is not swallowed by `.env.*` |
| 02 | `feat(payments): config + atomic money math` | `payments/{package,tsconfig,.env.example,src/config.ts,src/split.ts}` | decimal→atomic never rounds, split conserves value |
| 03 | `feat(payments): payment gate (mock + Hedera)` | `payments/src/gate/*` | 402 challenge is x402-v2 shaped; live SDK never loads in dev |
| 04 | `feat(payments): spend ledger + HCS audit` | `payments/src/{spend-log,http}.ts` | one line per paid call, totals are a reduce |
| 05 | `feat(payments): /ask paywall (verify→serve→settle)` | `payments/src/{paywall,meter}.ts` | a failed answer is never charged |
| 06 | `feat(payments): server + tests` | `payments/src/{server,index}.ts`, `payments/test/*` | 13 tests green, `tsc --noEmit` clean |
| 07 | `feat(payments): README + tip-token script` | `payments/README.md`, `payments/scripts/` | HTS fractional fee = the split, on the asset |
| 08 | `feat(agent): provider interface + registry` | `agent/{package,tsconfig,.env.example,src/types.ts,src/config.ts,src/providers/*}` | provider is config data, never code |
| 09 | `feat(agent): fence + budget` | `agent/src/{fence,budget}.ts`, `agent/data/artist.json` | injections cannot escape the fence; ceilings before network |
| 10 | `feat(agent): steward + tools + providers tests` | `agent/src/{steward,tools}.ts`, `agent/test/*` | structured output validated, one repair turn, no silent model swap |
| 11 | `feat(agent): x402 payer + server + scripts` | `agent/src/rails/payer.ts`, `agent/src/{server,http,index}.ts`, `agent/scripts/` | steward pays its own meter |
| 12 | `feat: end-to-end demo, RUNBOOK, ideation record` | `agent/README.md`, `docs/{RUNBOOK,AGENT-IDEATION}.md`, root `package.json` | the whole loop on localhost, dev mode, zero credentials |

---

## Definition of done for each step

- [ ] `npm --prefix <pkg> test` green (or "no tests yet, typecheck only" stated in the step doc)
- [ ] `npx tsc --noEmit -p <pkg>` clean
- [ ] every exported symbol has a doc comment saying *why* it exists, not what it does
- [ ] `docs/build-log/steps/NN-*.md` written and committed **in the same commit**
- [ ] `docs/build-log/LOG.md` has a row for it (author, date, files, test count)
- [ ] PR opened against the teammate's fork

## What is real vs mocked (carried forward, must stay true)

| Path | Status |
|---|---|
| Split arithmetic, ledger, budget ceilings, fence, provider parsing | **real code, tested** |
| 402 challenge shape, verify→serve→settle ordering | **real protocol shape, mock facilitator** |
| Hedera settlement | **written, never executed** — no credentials here. `docs/TX-PROOF.md` stays empty until testnet keys exist |
| 0G inference | **written, never executed** — `fake` provider is the offline default |
| HTS fractional-fee token | **script written, never run** |
