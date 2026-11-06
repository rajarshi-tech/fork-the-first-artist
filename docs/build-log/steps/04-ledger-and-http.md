# Step 04 — spend ledger, HCS audit trail, HTTP helpers

**Commit:** `feat(payments): spend ledger, HCS audit trail and http helpers`
**Author:** Rajarshi
**Files:** `payments/src/spend-log.ts`, `payments/src/http.ts`, `payments/test/spend-log.test.ts`

## Why

Two separate needs that happen to land together, because the paywall (step 05) needs both and neither is interesting alone:

1. **One authoritative record of what was charged.** The budget gate compares spend against three ceilings; it must read those numbers from a single place, or the cap is enforced against fiction.
2. **No framework.** Two endpoints and a health check do not justify a dependency tree.

## `spend-log.ts`

### One line per paid call, and nothing else

```
every paid call  →  exactly ONE line in data/spend-log.jsonl
budget totals    →  a reduce over that file
```

There is **no second in-memory set of books**. This was a real bug in the previous attempt: a summary was being written in addition to the entry line, which double-counted spend and would have tripped the ceiling at half the intended amount. The one-line invariant is now stated in the code *and* asserted in a test that counts raw lines on disk.

### `SpendEntry.kind`

| `kind` | Meaning | `priceAtomic` |
|---|---|---|
| `ask` | a fan paid the artist through the paywall | the ask price |
| `meter` | the steward paid for its own inference | the meter price |
| `template` | a degraded answer served without an LLM | **`'0'`** — nothing was charged |

Recording a `template` entry even though nothing was charged is deliberate: the ledger then *explains itself*. A gap would leave a reviewer guessing whether the answer was free or the write failed.

### HCS audit trail

| Mode | `hcsTxId` |
|---|---|
| `dev` | `hcs-mock-<16 hex>` — SHA-256 of the entry, so it is **deterministic** and a test can assert its exact shape |
| `live` | the real topic message id, `"<txId>@<status>"` |

Two deliberate decisions:

- **Best-effort, never blocking.** The audit write happens *before* the ledger line so the stored line already carries its HCS id, but a failure is caught and stored as `null`. The payment has already settled by then; losing the book entry would be strictly worse than losing the pointer to it.
- **The synthetic id is prefixed `hcs-mock-`** for the same reason mock tx ids are: it can never be mistaken for HashScan proof in `docs/TX-PROOF.md`.

`Client.forName()` wants `testnet`/`mainnet`, not the CAIP-2 `hedera:testnet` we store everywhere else, hence the `.replace('hedera:', '')`.

### Reading is forgiving on purpose

A malformed line is **skipped with a warning**, not a crash. The ledger is written by an at-least-once process; refusing to boot over one truncated final line in the middle of a demo is the wrong trade. Every skip prints to stderr so it is never silent.

`totals(now)` takes an injectable timestamp — the hourly-window test would otherwise have to sleep for an hour.

**`priceAtomic` (string) and `priceUsd` (number) are both stored.** The string is authoritative and never rounded; the number exists only for ceiling comparison and display. `round6` is applied **only** to aggregates.

## `http.ts`

Why hand-rolled instead of Express/Fastify: every dependency is a line the repo owner's agent must reproduce. Six small functions in one readable page beat a transitive tree.

| Function | The non-obvious decision |
|---|---|
| `sendJson` | `cache-control: no-store` is the **default**, not an option. Every response here is per-payer and contains settlement metadata; a shared cache serving one fan's answer to another would leak both the content and the proof. |
| `readBody` | hard 256 KB ceiling. This is a public paid endpoint; an unbounded body read is a trivial memory-exhaustion vector. |
| `parseJson` | returns `undefined` rather than throwing — a bad body becomes a clean 400, not an unhandled rejection. |
| `header` | returns `undefined`, never `''`. "No `X-PAYMENT`" and "`X-PAYMENT: ''`" are different states and the gate must distinguish them. |
| `log` | one JSON object per line, so `jq` and log shippers work with no config. |

## Verification

```bash
cd payments && npm test && npx tsc --noEmit
```

```
✔ ledger: one paid call writes exactly one line, and totals are a reduce over it
✔ ledger: a degraded (template) answer is recorded but adds no spend
✔ ledger: the hourly window only counts entries inside it
✔ ledger: dev HCS ids are deterministic and obviously synthetic
✔ ledger: a missing file is an empty ledger, not a crash
✔ ledger: recent() is newest-first
✔ ledger: describePrice never rounds a real amount
ℹ tests 19  ℹ pass 19  ℹ fail 0
```

(7 new + 12 from steps 02–03.) `tsc --noEmit` clean.

The hourly-window test is worth noting: it appends an **older entry after** a newer one, so it fails if the window is computed positionally (e.g. "last N entries") instead of by timestamp. It checks `totalUsd = 0.052` but `lastHourUsd = 0.002`.

Each test uses its own `mkdtemp` ledger path and removes it, so the suite is order-independent and never touches the repo's real `data/` folder.

## What is real vs mocked

| Real, tested | Written but never executed |
|---|---|
| one-line invariant, reduce-based totals, hourly window, template = zero spend, missing file, `recent()` ordering | `submitToHcs` live branch — needs a topic id and a funded key; never called against Hedera |

## Next

Step 05: the paywall and the meter — where `verify → serve → settle` makes "never charged for a failed answer" true.
