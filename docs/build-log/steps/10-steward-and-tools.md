# Step 10 — the steward and its tools

**Commit:** `feat(agent): steward entry point with tool loop, schema repair and degradation ladder`
**Author:** Rajarshi
**Files:** `agent/src/steward.ts`, `agent/src/tools.ts`, `agent/src/demo-artist.ts`, `agent/test/steward.test.ts`

## Why

Steps 08–09 built the pieces: a provider abstraction, a fence, a budget. This step is the **only place that knows the order they run in** — and the order *is* the design:

```
consent → provider → affordability → tool loop → schema → record spend
```

## `steward.ts`

### The two orderings that carry guarantees

**1. Affordability runs BEFORE the first network call.**

A request we cannot pay for never touches a provider, so it cannot cost anything. The caller gets a `template-reply` instead of an error.

**2. A degraded reply is `ok: true`, not an error.**

```ts
{ ok: true, degradation: 'template-reply', costUsd: 0 }
```

This is the detail that makes the whole product work. The paywall (a *different* service) reads `degradation` and serves the answer **free** — the agent spent nothing, so the fan pays nothing. Returning an error here would force the paywall into charge-or-fail, and both options are wrong. Test: `steward: unaffordable request degrades to a template reply, no model call`.

### The degradation ladder

| Rung | Change | Reported as |
|---|---|---|
| 1 | untouched request | — |
| 2 | `maxTokens` halved (min 64) | `shorter-max-tokens` |
| 3 | cheaper model from `config.fallback.chain` | `cheaper-model` |

Halving tokens is tried **before** switching models because it keeps *the model the artist's profile was tuned for*. A model change is the last resort and is **always reported** — never silent. When the fallback chain is disabled (the demo default), rung 3 does not exist, which is what keeps 0G the only inference path on stage.

### No silent model substitution — including across services

```ts
if (upstream === 'SPEND_CAP_EXCEEDED') {
  return this.templateReply(...);   // degrade, do not error
}
```

The payments meter refuses with `403 SPEND_CAP_EXCEEDED` when *it* is out of budget. That is the **same condition** the steward's own budget check detects — just discovered one hop later. Treating it as a provider error would surface a 500 to a fan for something that is not a failure. Test: `steward: the meter refusing on budget degrades, it does not error`.

This was a real cross-service bug found in the previous attempt by running the two services together; it is now pinned by a test.

### Structured output: one repair turn, then fail honestly

1. Parse the reply against the caller's schema.
2. On failure, spend **one** repair turn: *"That was not valid JSON for the required schema (…). Reply with ONLY the JSON object."*
3. If it fails again → `SCHEMA_MISMATCH`, retryable. **Never** a silently-unguaranteed reply.

`extractJson` tolerates the usual model noise (```` ```json ```` fences, prose around the object) so a cosmetic wrapper does not burn the repair turn.

### Other decisions

| Decision | Reason |
|---|---|
| Unknown tool names rejected **before** any model call | spending money to be told a tool does not exist is pure waste |
| Tool-loop output truncated to 4000 chars | one huge tool result must not blow up the context window |
| `mergeProvenance` — later wins, absent never overwrites present | the payment tx id usually arrives on the first metered call and the request id may arrive later; dropping either breaks the one-payment-to-one-inference binding |
| The fan's **question** is fenced too | a fan can type "ignore your rules" just as easily as an artist can put it in a bio |
| `consent: false` stops the run first, before provider or budget | consent is not a budget question |

## `tools.ts`

### v0 is read-only on purpose, and that is a security property

**No tool can move money.** Payments are made by the steward's own wallet in `rails/payer.ts`, driven by the *steward's* control flow — never by a model choosing to call `pay()`. The worst a jailbroken model can do here is read the public bio and do arithmetic.

This turns the fence from "must be perfect" into "defence in depth": even a total prompt-injection success cannot spend a fan's money.

### `quote_tip` prefers the live service

```ts
if (ctx.paymentsUrl) { /* GET /split-preview */ }
// fall through to identical local arithmetic, marked source: 'local'
```

The number the fan is **shown** comes from the same code that will **charge** them. Two implementations of the split disagreeing is exactly the bug we cannot afford, so the live service wins and the local fallback is labelled.

### Tool descriptions are prompt text

Each description states its constraint (`"List the artist's songs exactly as published. Never invent titles."`). The description is part of the safety surface, not documentation.

### Failure handling

A tool that throws returns `{ ok: false, output: { error } }` and the run continues — the model gets the error text and can correct itself. A hallucinated tool name is reported, never thrown.

## `demo-artist.ts`

`DEMO_ARTIST` is typed as a mutable `ArtistProfile` (not `as const`) so a test can spread it and override one field — `{ ...DEMO_ARTIST, consent: false }` — to prove the consent gate without fighting literal types.

It was added at this step because the steward tests need a profile and `index.ts` does not exist until step 11. Step 11 re-exports it.

## Verification

```bash
cd agent && npm test && npx tsc --noEmit
```

```
✔ steward: runs the tool loop, then answers, with provenance attached
✔ steward: artist data reaches the model fenced, never as instructions
✔ steward: refuses when the artist has not consented
✔ steward: unaffordable request degrades to a template reply, no model call
✔ steward: the degradation ladder runs shorter before it gives up
✔ steward: structured output is validated, and one repair turn is allowed
✔ steward: unrecoverable schema mismatch fails loudly
✔ steward: unknown tool is rejected before any model call
✔ steward: a provider error surfaces as PROVIDER_UNAVAILABLE, not a crash
✔ steward: the meter refusing on budget degrades, it does not error
ℹ tests 42  ℹ pass 42  ℹ fail 0
```

(10 new + 32 from steps 08–09.) `tsc --noEmit` clean.

Each test's assertion is worth reading in the file: they check **that no model call happened** for the consent and budget paths (not just the status), that tool output appears in the envelope, and that the meter's `403` degrades rather than errors.

## What is real vs mocked

| Real, tested | Mocked at this step |
|---|---|
| ordering, consent gate, affordability-before-network, ladder, schema repair, tool loop, cross-service 403 handling, provenance merge | the provider is the `fake` adapter — no network, no keys, no cost |

## Next

Step 11: `rails/payer.ts` (the wallet that pays the meter), the HTTP server and the scripts.
