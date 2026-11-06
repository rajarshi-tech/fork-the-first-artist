# Step 05 — paywall (`/ask`) and meter (`/meter/v1/chat/completions`)

**Commit:** `feat(payments): paywall and pay-per-call inference meter`
**Author:** Rajarshi
**Files:** `payments/src/paywall.ts`, `payments/src/meter.ts`, `payments/test/payments.test.ts`

## Why

These are the two endpoints the entire project is demonstrated through:

| Endpoint | Who pays | Who gets paid | What it proves |
|---|---|---|---|
| `POST /ask` | a fan | **the artist** | the artist's own account receives fan money through an x402 challenge |
| `POST /meter/v1/chat/completions` | **the steward agent** | the agent's compute wallet | an agent pays for its own inference, autonomously, with no human in the loop |

One component, both sponsors: the meter is Hedera's "AI Agents That Pay" example verbatim, and every response carries 0G's `request_id` + `tee_verified` **bound 1:1 to a payment tx id** — that pair is the submission artifact.

## The ordering that carries the guarantees

```
   budget check ──► 402 ──► verify ──► ANSWER/INFER ──► settle ──► log ──► 200
```

### 1. `settle()` is last

This is the mechanism, not a style choice. Every failure path `return`s before it:

| Failure | Status | Settled? |
|---|---|---|
| steward unreachable | 502 | **no** |
| steward refuses (no consent, schema failure) | 422 | **no** |
| degraded template answer | 200 with `charged: false` | **no** |
| upstream inference fails | 502 | **no** |
| budget exhausted | 403 | **no** |
| missing instruction | 400 | **no** |

> **"A fan is never charged for an answer that failed or degraded"** is the claim. It is only true if `settle()` is unreachable on those paths, so every test asserts a **`settle()` call counter**, not just the HTTP status. A ledger that looks right while settlement is wrong would be the worst possible bug.

### 2. The budget check is **before** the 402

Never quote a payment we are not allowed to serve. If we quoted first and refused after, a client would hold a signed payment for a call that can never be honoured.

### 3. Spend cap returns **403, not 402**

A 402 means "pay me". Returning it when we mean "I am out of money and will refuse" would invite a payment we cannot serve. `403 SPEND_CAP_EXCEEDED` is honest, and it is a **signal**: the steward's degradation ladder turns it into a template reply and the fan is not charged either — so a budget exhaustion costs *nobody*.

## `paywall.ts`

- **`payTo` resolves from `?payTo=`** (which a client reads from the artist's ENS text record), falling back to config. It is never an account of ours.
- **`requirementsFor()` builds the object handed to `verify()`, `challenge()` and `settle()`.** It must be the **identical value** in all three, or the facilitator rejects the payment as a mismatch — so it is one function, not three object literals.
- **422 for a steward refusal, 502 for an outage.** A refusal was understood and declined; an outage is infrastructure. Conflating them would tell a fan their request was rejected when in fact we were down.
- **`unsent-…` tx ids** are self-labelling: if `settle()` ever produced no id, the ledger says so instead of inventing something that looks like a transaction.
- **`proof.upstream.requestId` + `proof.paymentTxId`** are emitted side by side. Binding them is the point: one payment ↔ one inference.
- **`x-payment-response` header** carries the base64 settlement receipt separately, so a client can read the proof without parsing our JSON.

`StewardReply` is structurally typed here rather than imported from `agent/`. The two packages must stay independently installable and re-implementable in either order; a shared type import would couple them.

## `meter.ts`

- **Paid to `cfg.accounts.compute`, not the artist.** This endpoint is the agent paying for itself.
- **`verify_tee: true` + `X-0G-Provider-Trust-Mode`.** 0G flags; meaningless to other providers, which is why the meter is 0G-shaped rather than generic.
- **The request id is read from the header first, the `x_0g_trace` block second** — the header is authoritative when present.
- **The upstream response is passed through unchanged**, so the meter is a drop-in for any OpenAI-compatible endpoint, **plus** one extra `x_meter` block that makes it auditable.
- **Dev mode with no `UPSTREAM_API_KEY` synthesises an OpenAI-shaped response**, so the whole two-service loop is demoable offline. Every field that could be mistaken for real provenance is prefixed `dev-`, and the text is labelled `[dev-mock inference]`.
- **45 s `AbortSignal.timeout`** on inference: slow is allowed, hung is not.
- **Non-2xx upstream bodies are truncated to 300 chars** before logging, so a proxy's HTML error page never floods the log.

## Verification

```bash
cd payments && npm test && npx tsc --noEmit
```

```
✔ paywall: 402 without payment, then a paid answer with split proof
✔ paywall: a steward outage charges nobody
✔ paywall: a degraded template answer is free, not merely cheap
✔ paywall: a steward refusal is a 422 that says nothing was settled
✔ paywall: an empty instruction is a 400 before any payment talk
✔ paywall: ?payTo= routes funds to the artist from their ENS record
✔ meter: 402 challenge is protocol-shaped and priced
✔ meter: a paid call returns the answer, the payment tx and the 0G request id
✔ meter: budget exhaustion refuses with 403 before quoting a payment
✔ meter: the hourly ceiling is enforced separately from the total
✔ meter: /meter/info advertises the price and budget without needing payment
ℹ tests 30  ℹ pass 30  ℹ fail 0
```

(11 new + 19 from steps 02–04.) `tsc --noEmit` clean.

The test harness has two parts worth noting:

- **`countingGate()`** wraps the mock gate and counts `settle()` calls. Every "was the fan charged?" assertion goes through it rather than through the ledger — the ledger could agree with a wrong settlement.
- **A fake `Ctx`** rather than a live HTTP server: the handlers take `Ctx`, so each test is a few milliseconds and there are no ports, races or teardown flakiness. Each test also gets its own `mkdtemp` ledger.

Specific assertions worth reviewing:

| Test | Asserts |
|---|---|
| 402 → paid answer | `accepts[0].amount === '100000'`; split `96310` / `3690`; `hashScan` URL is `/testnet/`; `proof.payTo === cfg.accounts.artist` |
| steward outage | `settled === 0` **and** zero ledger lines |
| degraded reply | `charged: false`, `settled: false`, `proof: null`, `settled === 0` |
| budget exhaustion | `403`, `code: SPEND_CAP_EXCEEDED`, `scope: 'total'`, `settled === 0` |
| hourly ceiling | enforced independently of the total (`scope: 'hourly'`) |

## What is real vs mocked

| Real, tested | Mocked at this step |
|---|---|
| ordering, charging rules, budget enforcement, split arithmetic, proof shape, ledger writes | the **facilitator** (mock gate) and the **upstream model** (dev stand-in). No network, no keys, no chain |

## Next

Step 06: the HTTP server that wires these two handlers plus `/health`, and the package's test run becomes the full suite.
