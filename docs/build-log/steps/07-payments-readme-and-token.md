# Step 07 — payments README + the HTS tip-token script

**Commit:** `docs(payments): README with status table; feat(payments): HTS split token script`
**Author:** Rajarshi
**Files:** `payments/README.md`, `payments/scripts/create-tip-token.ts`

## Why

Two gaps closed:

1. **The package had no entry point for a reader.** Steps 02–06 built a service whose design decisions are only visible in commit messages. The README has to state the decisions *and* the honest status.
2. **The split had no on-chain implementation.** `split.ts` computes 96.31 / 3.69 locally for the ledger and the UI, but `split.ts` does not move real money. This script is where the split actually lives for a real deployment.

## `scripts/create-tip-token.ts`

### The problem it solves

An x402 `exact` payment is **one transfer to one `payTo`**. The split therefore **cannot** happen in the protocol. It has to happen **on the asset**:

```
fan ──0.10 OSOTIP──► artist account
                       └─ HTS fractional fee 369/10000 ──► 0.00369 ──► agent compute account
```

Hedera does this natively — a fractional custom fee routes the agent's share to the compute account **atomically, in the same transaction**, with no contract to deploy and no second transaction that could fail between the two legs. Hedera's own bonus list calls this out specifically.

### Choices in the script, and why

| Choice | Reason |
|---|---|
| `.setAssessmentMethod(Inclusive)` | the fee is taken **out of** the amount sent, so a 0.10 tip charges the fan exactly 0.10 and splits it — rather than charging 0.10 and asking for more |
| `.setFeeCollectorAccountId(computeId)` | the collector is the agent's own wallet. Nobody else receives the 3.69% |
| `.setMax(Hbar.fromTinybars(1_000_000))` | Hedera requires an explicit cap; too low a cap would silently swallow a demo tip |
| `.setAllCollectorsAreExempt(true)` | so the fee does not recurse when the agent moves its own funds |
| `.setInitialSupply(0)` | nothing is minted until an artist is actually onboarded — consistent with "consent first" |
| `agentBps <= 0 \|\| >= 10_000` → exit | a 0% fee silently makes the agent free; 100% takes the artist's entire tip. Both are config mistakes that should never mint a token |
| dynamic `await import('@hiero-ledger/sdk').catch(...)` | prints "install the SDK first" instead of a raw `ERR_MODULE_NOT_FOUND` |
| `need(k)` exits with the **variable name** | an operator gets an instruction, not a stack trace |

## `README.md`

The structure is chosen for a judge with five minutes and a teammate with a merge conflict:

1. **The two endpoints in a table** — who pays whom, at what price.
2. **Quickstart (dev, no keys)** and **Live mode** as separate sections, because dev mode is what everything was verified against.
3. **Design decisions numbered and argued** — the ordering, budget-before-402, 403-not-402, never-a-float, one-line ledgers, lazy SDKs. Each with its failure mode.
4. **The environment table**, including the note that `HEDERA_ASSET` came from `@x402/core`'s `DEFAULT_ASSETS` and **not** the docs (which said `0.0.6001`).
5. **The status table** — the single most useful section. Every row says "real, tested" or "written, never executed".
6. **A test table** saying which file proves which property.
7. **AI disclosure**, per the team rule.

The status table exists because an unqualified "works" is worth nothing to a judge who asks "which part did you actually run?".

## Verification

```bash
cd payments && npm test && npx tsc --noEmit
# ℹ tests 39  ℹ pass 39  ℹ fail 0
# tsc --noEmit: clean

node scripts/create-tip-token.ts
# missing env HEDERA_TREASURY_ACCOUNT_ID — see .env.example / docs/RUNBOOK.md
```

The script's failure path was exercised: it exits **cleanly with the variable name**, no stack trace. That is the only behaviour of this script that has been observed.

## What is real vs mocked

| Real, tested | Written, never executed |
|---|---|
| README claims (all cross-checked against `npm test`) | **the whole token-creation path.** No funded Hedera account existed while it was written. It must not be reported as working until it mints a token on testnet and the id lands in `HEDERA_ASSET`. |

## Next

Step 08: `agent/` — the provider interface and registry. Provider choice becomes configuration data, never code.
