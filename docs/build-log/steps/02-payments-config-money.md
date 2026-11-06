# Step 02 — payments config + atomic money math

**Commit:** `feat(payments): config and exact atomic money math`
**Author:** Rajarshi
**Files:** `payments/package.json`, `payments/tsconfig.json`, `payments/.env.example`, `payments/src/config.ts`, `payments/src/split.ts`, `payments/test/split.test.ts`

## Why

Two things have to be unarguable before any chain code exists:

1. **Money is never a float.** Hedera assets are integers; `0.1 + 0.2` in binary floating point is not `0.3`. Every amount in this service is a `bigint` in atomic units, and there is exactly one place a decimal string is converted.
2. **A misconfigured split must stop the process.** The 96.31 / 3.69 split is the product's ethical claim. Shipping a wrong split silently is the worst possible failure.

## File-by-file

### `payments/package.json`

`"type": "module"`, Node `>=22.18`. **No build step**: `node src/server.ts` runs the TypeScript directly via Node's type stripping, so what a reviewer reads is what executes.

The three Hedera/x402 packages are **`optionalDependencies`**:

| Package | Version | Why optional |
|---|---|---|
| `@x402/core` | 2.30.0 | wire format + client, only needed in `live` mode |
| `@x402/hedera` | 2.30.0 | Hedera scheme, only in `live` |
| `@hiero-ledger/sdk` | 2.90.1 | signing and HTS, only in `live` |

This is load-bearing: `PAYMENTS_MODE=dev` must boot with **none of them installed**, otherwise the repo is not demoable on a teammate's machine without a network install of three heavy chains of dependencies. Step 03 keeps that promise with a lazy dynamic import.

### `payments/tsconfig.json`

`strict`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `types: ["node"]`.
No `outDir`, no `declaration` — this config exists **only** to typecheck. The absence of an emit path is intentional; it matches the no-build-step rule from step 01.

### `payments/.env.example`

Every variable the service reads, grouped, documented. `PAYMENTS_MODE` is first because it decides everything else.

Notable values, all verified rather than guessed:

| Variable | Default | Source of truth |
|---|---|---|
| `HEDERA_ASSET` | `0.0.429274` | `DEFAULT_ASSETS["hedera:testnet"]` in `@x402/core`'s shipped dist. The docs said `0.0.6001` — the **package** was right |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | the public testnet facilitator listed for the Hedera x402 track |
| `SPLIT_ARTIST_BPS` / `SPLIT_AGENT_BPS` | `9631` / `369` | team plan: 3.69% funds the agent's own compute, OSO takes zero |
| `BUDGET_TOTAL_USD` | `5` | team plan's demo budget |

### `payments/src/config.ts`

**`decimalToAtomic(value, decimals)`** — `"0.002"` + 6 → `2000n`. It **throws** rather than truncating:

```ts
decimalToAtomic('0.0000001', 6)   // throws: "has more than 6 decimals; would lose funds"
```

Silent truncation here would turn a paid endpoint into a free one. Throwing makes the operator fix a typo.

**`atomicToDecimal(atomic, decimals)`** — inverse, for logs and UI, always showing all decimals.

**`loadConfig(overrides)`** — three-phase by design:
1. read env into a typed object,
2. apply `overrides` (tests need this),
3. **validate after merging**, so an override cannot bypass the split check.

Validation rules:

| Rule | Failure mode it prevents |
|---|---|
| `PAYMENTS_MODE` must be `dev` or `live` | a typo silently running in the wrong mode |
| `artist + agent === 10000` bps | shipping a wrong split |
| `live` requires both account ids, named in the error | discovering a missing account mid-demo |
| `dev` fills in `0.0.5555` / `0.0.6666` | dev needing credentials it will never use |

There is deliberately **no `prod` mode**. This is a testnet hackathon demo, and a mode name implying production safety would be dishonest.

**`loadDotEnv`** — a ~20-line `.env` reader so the repo has no `dotenv` dependency. A real environment variable always wins over the file, so `PORT=9000 npm start` overrides `.env`.

### `payments/src/split.ts`

This is the arithmetic the whole pitch rests on, written so a reader can verify it without trusting it:

```ts
const agent  = (total * BigInt(bps.agent)) / 10_000n;  // floors
const artist = total - agent;                          // subtraction, not division
```

Two deliberate choices:

- **Floor the agent, remainder to the artist.** `bigint` division truncates toward zero, so on a 7-atomic-unit payment the agent gets 0 and the artist keeps all 7. Rounding can never favour the agent, and can never create value.
- **Subtract instead of dividing twice.** `artist = total - agent` is what *guarantees* `artist + agent === total`. Two independent divisions could lose a unit.

`assertConserved(s)` exists as a cheap runtime gate for tests and the ledger writer.

`describeSplit(s, decimals)` formats without `Number()`, so the UI cannot display a rounded amount that differs from the one charged.

## The split, two places, one arithmetic

One x402 `exact` payment is **one transfer to one `payTo`** — it cannot be split during settlement. So the real on-chain split is an **HTS fractional custom fee of 369/10000** baked into the artist's tip token (step 07, `scripts/create-tip-token.ts`). This module is the same arithmetic done locally, so the ledger and the UI can state what the fee will do, and tests prove conservation with no network.

## Verification

```bash
cd payments && npm install
npm test        # 6/6 pass
npx tsc --noEmit  # clean
```

Test results:

```
✔ split conserves value at every amount up to 100000 atomic
✔ split is exactly 96.31 / 3.69 on a 0.10 USDC tip
✔ split gives the rounding remainder to the artist, never the agent
✔ rejects a split that does not total 10000 bps
✔ atomic conversion refuses precision loss
✔ loadConfig refuses a bad split total
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

The first test is exhaustive rather than a sample: it walks **every** amount from 0 to 100,000 atomic units and asserts conservation at each one. That is 100,001 cases in 14 ms, which is cheap enough to keep.

## What is real vs mocked

| Real, tested | Mocked / absent |
|---|---|
| atomic conversion, split arithmetic, config validation | no network, no chain, no signing at this step |

## Next

Step 03: the payment gate — a mock implementation and a Hedera one behind a single interface, with the live SDK loaded lazily so step 02's zero-dependency promise survives.
