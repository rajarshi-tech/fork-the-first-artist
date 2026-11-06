# 💸 payments — x402 on Hedera

Two x402-protected endpoints, one split, one audit log.

| Endpoint | Who pays | Price | Goes to |
|---|---|---|---|
| `POST /ask` | a fan (or a fan's agent) | 0.10 USDC | the **artist's** own account |
| `POST /meter/v1/chat/completions` | the artist's **steward agent** | 0.002 USDC | the agent's compute account |

The second one is the important one for the sponsor tracks: it is an
OpenAI-compatible inference proxy that charges **per call**, so the agent pays for
its own thinking out of its own wallet with no human in the loop.

```
fan ──POST /ask (402)──► payments ──► steward ──POST /meter/… (402)──► meter ──► 0G Router
         pay 0.10                │        pay 0.002                   │
         settle ◄────────────────┘        settle ◄────────────────────┘
            │                                 │
            └── 96.31% artist / 3.69% agent ───┴── HCS spend topic (audit)
```

---

## Quickstart — dev mode (no keys, nothing on chain)

```bash
npm install
cp .env.example .env          # PAYMENTS_MODE=dev is the default
npm start                     # :8402
npm test                      # 39 tests
```

`PAYMENTS_MODE=dev` uses a **mock gate**: 402 challenges are protocol-shaped and
every settlement id is `mock-…`. Nothing touches Hedera. This is what the test
suite and the offline demo run against — the repo is fully demoable with no
credentials and no chain SDKs installed (`npm install --omit=optional` still
passes every test).

## Live mode (Hedera testnet, real settlement)

```bash
cp .env.example .env
# in .env:
#   PAYMENTS_MODE=live
#   HEDERA_ARTIST_ACCOUNT_ID / HEDERA_COMPUTE_ACCOUNT_ID   (testnet, ECDSA keys)
#   HEDERA_AGENT_PRIVATE_KEY                               (compute account, pays the meter)
#   HCS_SPEND_TOPIC_ID                                     (audit topic)
npm start
```

`live` **refuses to start** without the account ids and names the missing
variables. It does not half-start and discover the gap mid-demo.

### The token with the split built in

An x402 `exact` payment is one transfer to one `payTo`, so the 96.31 / 3.69 split
cannot happen in the protocol — it happens **on the asset**, as an HTS fractional
custom fee (369 / 10000) that routes the agent's share to the compute account
atomically, in the same transaction.

```bash
npm run token:create     # prints a token id
# put it in .env as HEDERA_ASSET=<token id>, then restart
```

> ⚠️ `scripts/create-tip-token.ts` is written against `@hiero-ledger/sdk@2.90.1`
> but **has never been executed** — no funded Hedera account was available. Treat
> it as untested until it mints a token on testnet.

---

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/ask` | POST, GET | x402 | fan pays the artist, steward answers |
| `/meter/v1/chat/completions` | POST | x402 | agent pays per inference call |
| `/meter/info` | GET | free | price, budget, upstream config |
| `/meter/v1/models` | GET | free | catalog — learn the model name *before* paying |
| `/.well-known/x402` | GET | free | machine-readable discovery: prices, payees, split |
| `/split-preview?amount=0.10` | GET | free | the split arithmetic for any amount |
| `/ledger/recent?n=20` | GET | free | tail of the spend ledger |
| `/health` | GET | free | liveness + **which mode/gate is live** |

---

## Design decisions (the parts worth arguing about)

### 1. `verify → serve → settle`, in that order

`gate.settle()` is the **last** call, made only after an answer exists. Every
failure path returns before it, so a fan is never charged for an answer that
failed or degraded:

| Failure | Status | Settled |
|---|---|---|
| steward unreachable | 502 | **no** |
| steward refuses (no consent, bad schema) | 422 | **no** |
| upstream inference fails | 502 | **no** |
| degraded template answer | 200, `charged: false` | **no** |
| budget exhausted | 403 | **no** |

### 2. The budget check happens **before** the 402

Never quote a payment we are not allowed to serve. If we quoted first and refused
after, a client would hold a signed payment for a call that can never be honoured.

### 3. The spend cap returns **403**, not 402

A 402 means "pay me". Returning it when we mean "I am out of money and will refuse"
would invite a payment we cannot serve. `403 SPEND_CAP_EXCEEDED` is honest, and it
is a **signal**: the steward's degradation ladder turns it into a template reply and
the fan is not charged either. Budget exhaustion costs nobody.

### 4. Money is never a float

Every amount is a `bigint` in atomic units. `decimalToAtomic` **throws** rather than
truncating, because truncating `0.0000001` on a 6-decimal asset would make a paid
endpoint free.

The split **floors the agent share** and gives the remainder to the artist by
subtraction, so `artist + agent === total` holds for every amount — proven
exhaustively for all 0…100,000 atomic units in the tests.

### 5. One ledger line per paid call

Totals are a `reduce` over `data/spend-log.jsonl`. There is deliberately no second
in-memory set of books; two sets of books can disagree and then nobody knows which
one the cap was enforced against.

### 6. The chain SDKs are optional dependencies, loaded lazily

`@x402/*` and `@hiero-ledger/sdk` are imported only when `PAYMENTS_MODE=live`.
Dev mode boots with **none of them installed** — verified by running the whole test
suite after `npm install --omit=optional`.

---

## Environment

See `.env.example` for the full list with defaults. The ones that matter:

| Variable | Default | Note |
|---|---|---|
| `PAYMENTS_MODE` | `dev` | `dev` or `live`. There is no `prod` — this is a testnet demo |
| `HEDERA_NETWORK` | `hedera:testnet` | CAIP-2 style |
| `HEDERA_ASSET` | `0.0.429274` | testnet USDC. Taken from `@x402/core`'s `DEFAULT_ASSETS`, **not** the docs |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | public testnet facilitator |
| `SPLIT_ARTIST_BPS` / `SPLIT_AGENT_BPS` | `9631` / `369` | must total 10000 or the process refuses to start |
| `PRICE_ASK_USDC` | `0.10` | fan → artist, per question |
| `PRICE_METER_USDC` | `0.002` | steward → meter, per inference call |
| `BUDGET_TOTAL_USD` | `5` | demo budget |
| `BUDGET_HOURLY_USD` | `0.05` | rolling ceiling |
| `UPSTREAM_BASE_URL` | `https://router-api.0g.ai/v1` | 0G Compute Router |
| `UPSTREAM_TRUST_MODE` | `verified` | asks 0G for a TEE attestation |

---

## Status: what is real and what is not

This table is the honest one. It is more useful to a judge than an unqualified
"works".

| Component | Status |
|---|---|
| split arithmetic, atomic conversion, config validation | **real, tested exhaustively** |
| ledger, one-line invariant, hourly window, HCS mock | **real, tested** |
| 402 challenge shape, verify → serve → settle ordering | **real protocol shape, mock facilitator** |
| budget ceilings, 403 signalling, free-on-degradation | **real, tested** |
| HTTP server, CORS, discovery, health | **real, tested, and booted** |
| **Hedera settlement** | **written, never executed** — no credentials. `docs/TX-PROOF.md` stays empty until a real tx settles |
| **0G inference** | **written, never executed** — `fake`/dev stand-in is what ran |
| **HTS fractional-fee token** | **script written, never executed** |

---

## Tests

```bash
npm test           # 39 tests, no network, no keys
npm run typecheck  # tsc --noEmit
```

| File | Covers |
|---|---|
| `split.test.ts` | exhaustive conservation 0…100,000 atomic, rounding direction, precision refusal |
| `gate.test.ts` | x402 v2 wire format literally, mock labelling, payee fallback |
| `spend-log.test.ts` | one line per call, reduce-based totals, hourly window, template = zero |
| `payments.test.ts` | **the charging rules** — asserted with a `settle()` call counter, not just status codes |
| `server.test.ts` | routing, CORS/preflight, size ceiling, discovery, on port 0 |

---

## AI disclosure

Written with AI assistance (documented step by step in `docs/build-log/`). Every
claim in the status table above was checked by running the code; the three
"never executed" rows are the parts that could not be.

## Related docs

- [`../docs/build-log/PLAN.md`](../docs/build-log/PLAN.md) — the 12-step plan
- [`../docs/build-log/steps/`](../docs/build-log/steps/) — one doc per commit
- [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md) — dev → live testnet
- [`../docs/TX-PROOF.md`](../docs/TX-PROOF.md) — settled transaction ids (empty until live)
