# Step 03 — the payment gate (mock + Hedera)

**Commit:** `feat(payments): payment gate interface, dev mock and Hedera/x402 implementation`
**Author:** Rajarshi
**Files:** `payments/src/gate/types.ts`, `payments/src/gate/hedera.ts`, `payments/src/gate/index.ts`, `payments/test/gate.test.ts`

## Why

The meter and the paywall must not know whether they are talking to a chain. They need three questions answered — *price it*, *is this payment valid*, *move the money* — and the answer must be the same in a zero-credential local run and in a real Hedera testnet settlement. Everything sponsor-specific is confined to one file so a reviewer can audit it in isolation.

## The contract

```
  challenge()           verify()             settle()
  ─────────► 402        ─────────► payer?    ─────────► txId
  (price it)           (is the signed       (move the funds,
                        transfer valid?)     AFTER the handler ran)
```

`settle()` being **last** is not incidental — it is the mechanism behind "a fan is never charged for an answer that failed" (step 05).

### `gate/types.ts` — the interface + the dev mock

`PaymentRequirementsView` is **not our shape**, it is the wire format from `@x402/core@2.30.0`'s `paymentRequirementsSchema`. Field names (`scheme`, `network`, `amount`, `asset`, `payTo`, `resource`, `maxTimeoutSeconds`, `extra`) are copied verbatim, because a client on the other end parses them literally. Two consequences worth stating:

- `amount` is a **string** of atomic units. JSON has no bigint and a float would lose precision on a 6-decimal asset.
- `payTo` for `/ask` is the **artist's own account**. The gate never has an "our account" to fall back to.

`createMockGate` produces the real v2 shape with none of the chain:

| Property | Why it matters |
|---|---|
| body `{ x402Version: 2, accepts: [...] }` | identical to live, so client code written in dev works unchanged in live |
| `payment-required` header = base64(JSON) | the actual v2 wire header any x402 client reads |
| `cache-control: no-store` | settlement metadata is per-payer; a shared proxy must never store it |
| `extra.devMock: true` + error text | a dev challenge can never be mistaken for a real one |
| tx ids prefixed `mock-` | the same guarantee for the settlement proof string |

`verify()` accepts any non-empty header in dev. That is deliberate and stated in the code: dev mode exists to exercise the flow, not to pretend to check a signature.

### `gate/hedera.ts` — the live implementation

Speaks the facilitator's three documented endpoints directly instead of pulling in the resource-server middleware:

| Endpoint | Purpose |
|---|---|
| `GET /supported` | which `network`/`scheme` pairs are honoured, plus the facilitator's `feePayer` |
| `POST /verify` | `{x402Version, paymentPayload, paymentRequirements}` → `{isValid, invalidReason?, payer?}` |
| `POST /settle` | same body → `{success, transaction, network, payer?, errorReason?}` |

`transaction` from `/settle` is the Hedera tx id — the exact string for `docs/TX-PROOF.md` and the submission form.

Four deliberate behaviours:

1. **`/supported` is checked on the first challenge**, not blindly trusted. Pointing at a facilitator on the wrong network fails immediately and loudly with the list of what it *does* support, rather than emitting a 402 no client can satisfy mid-demo.
2. **Both base64 and raw JSON `X-PAYMENT` are accepted.** v2 sends base64 (`encodePaymentSignatureHeader`), but hand-written curl tests send raw JSON. Anything else returns `null` → a clean 402, never a crash.
3. **The payload is not validated here.** The facilitator is the authority on whether a signed Hedera transfer is valid. Duplicating that logic would be a second source of truth that can disagree.
4. **`txId` is only set when `success === true`.** A failed settle never leaks a placeholder that could end up in a submission.

Every `fetch` has an `AbortSignal.timeout` (20–30 s) so a hung facilitator fails one request instead of wedging the process.

### `gate/index.ts` — the factory, and the one line that matters

```ts
if (cfg.mode !== 'live') return createMockGate(cfg);
const { createHederaGate } = await import('./hedera.ts');   // ← lazy
```

The factory is `async` *for this reason only*. A synchronous factory would have to import `hedera.ts` at module scope, which would make the chain SDKs mandatory in dev mode and break step 02's `optionalDependencies` promise.

## Verification

```bash
cd payments && npm test && npx tsc --noEmit
```

```
✔ gate: dev mode returns the mock gate, and no chain SDK is needed
✔ gate: 402 carries the x402 v2 body and the payment-required header
✔ gate: dev challenges are explicitly labelled as mock, not settled
✔ gate: verify refuses a missing header instead of charging nobody
✔ gate: verify rejects, settle succeeds, and mock tx ids are never mistaken for real ones
✔ gate: payTo falls back to the configured artist account, never to us
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

(The 6 new gate tests plus the 6 from step 02.) `tsc --noEmit` clean.

### The lazy-import claim, tested rather than asserted

The dependency being *optional* is easy to state and easy to get wrong. So it was proven in a throwaway copy:

```bash
cp -r src test package.json tsconfig.json .backup/noopt/
cd .backup/noopt && npm install --omit=optional
ls node_modules/@x402          # → No such file or directory
node --test test/*.test.ts     # → tests 12  pass 12  fail 0
```

**With zero chain dependencies installed, all 12 tests pass in dev mode.** The optional-dependency promise is real.

## What is real vs mocked

| Real, tested | Written but never executed |
|---|---|
| x402 v2 challenge shape (body + header), verify/settle ordering, mock settlement, `payTo` fallback, mock-labelling | `createHederaGate` — the whole live path. No facilitator, no accounts, no credentials in this environment |

`hedera.ts` is written against the field names in `@x402/core@2.30.0`'s shipped source, but it has **never made a network call**. That must not be reported as working until testnet keys settle one real transaction.

## Next

Step 04: the spend ledger and the small HTTP helpers — one line per paid call, with totals as a reduce over that file.
