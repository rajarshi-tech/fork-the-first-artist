# Step 08 — the provider interface and registry

**Commit:** `feat(agent): provider-agnostic interface, config-driven registry and four adapters`
**Author:** Rajarshi
**Files:** `agent/package.json`, `agent/tsconfig.json`, `agent/.env.example`, `agent/config/providers.example.json`, `agent/src/types.ts`, `agent/src/config.ts`, `agent/src/providers/*.ts`, `agent/src/rails/payer.ts`, `agent/test/config.test.ts`

## Why — this is the requirement, verbatim

> *"a configuration for the choice of agent/provider (gemini, anthropic, openai, 0g or hedera and so on), and then an interface which encapsulates the providers and abstracts the choice. we will call that interface with the choice of our model/provider and give our instruction to the interface, and the interface will pass on the instructions to the correct agent and return output in proper format."*

`src/types.ts` is that interface. Callers write one call:

```ts
const out = await steward.run({ provider: '0g', instruction, tools, output, budget });
// → { ok, reply, provider, model, usage, costUsd, provenance, toolCalls, latencyMs }
```

and the envelope is identical whichever vendor answered.

## The rule that keeps the abstraction real

**Everything above `src/providers/` speaks only `types.ts`.** No vendor shapes, no SDK types, no `any` leaking upward. The moment a vendor quirk escapes into `steward.ts`, swapping providers stops being a config change. The vendor differences each adapter is responsible for:

| Vendor | Quirk the adapter hides |
|---|---|
| OpenAI-compatible (also 0G, local) | near-baseline; tools are function objects in a `tools` array |
| Anthropic | `system` is a **top-level** field; content is a **block array**; tool results are `tool_result` blocks |
| Gemini | `contents`/`parts`; tools are `functionDeclarations`; JSON mode is `responseSchema` |
| Fake | offline; must never claim a payment or a TEE attestation |

## `src/types.ts`

Design choices worth defending:

| Choice | Reason |
|---|---|
| `ErrorCode` is a **closed union** | the paywall is a separate service that switches on these codes. Adding a failure mode must be a compile error at the consumer, not a string that falls through to a generic 500 |
| `AgentResult` is a **discriminated union on `ok`** | `if (!res.ok)` narrows. A caller cannot forget to check |
| `ArtistProfile` is the **whole world** the model may know about the artist | no scraping, no fetch. "Consent first" is enforced by the type, not by policy |
| `ProviderConfig.envKey` is a **name**, never a key | config files are committed; secrets are not |
| `degradation` present ⇒ **do not charge** | the paywall reads it. A canned answer must cost the fan nothing |
| `Provenance` pairs `requestId` + `paymentTxId` | that pair is the submission artifact: one payment bound to one inference |

## `src/config.ts`

**No schema library**: the config is small and *the error messages are the documentation*. Every throw names the file, the provider and the field.

Two rules:

1. **A fresh clone must boot.** `config/providers.json` is gitignored (it may differ per machine), so the loader falls back to the checked-in `providers.example.json`.
2. **A wrong config stops the process, not the demo.** Unknown capability, dangling `default`, missing `baseUrl` — all throw at load.

`providerAvailability()` treats `x402-meter` as usable **without a key**, because *the meter holds the upstream key* — the agent only needs a wallet. That is the architectural point: the agent never holds a vendor API key. When no wallet key exists it is still usable with a reason (`dev/mock payment`), and that reason is what `/health` shows so nobody mistakes a mock run for a real one.

## `src/providers/registry.ts` — the one rule that matters

> A configured provider without credentials is **UNAVAILABLE**, and we say so, instead of quietly falling back to a different model.

Silent substitution is how a demo lies about where its answers came from. 0G's router refuses to do it for the same reason. The error names the provider **and** the missing variable:

```
openai: OPENAI_API_KEY is not set — set it, or use transport x402-meter
```

`forceFake` is the only route to the offline provider, so a fake answer can never appear by accident.

## `src/rails/payer.ts` — `Payer` as a fetch wrapper

```ts
interface Payer { kind: 'mock' | 'hedera'; accountId?: string; fetch(url, init): Promise<Response> }
```

Paying is an **HTTP concern**, so the payer is a `fetch` wrapper that attaches `X-PAYMENT` — not a `pay()` method. That is what lets the meter transport reuse the exact same adapter code path as a direct call: only `doFetch` changes.

## Verification

```bash
cd agent && npm test && npx tsc --noEmit
```

```
✔ config: ships a valid default provider catalog
✔ config: every inference provider is described as data, with no secret
✔ config: rejects a default provider that is not configured
✔ config: rejects an unknown capability, rather than silently disabling a feature
✔ config: env tightens a budget without editing the committed config
✔ providerAvailability: a missing key is reported, not hidden
✔ registry: an unknown provider names the ones that exist
✔ registry: a rail entry is not an inference provider
✔ registry: a configured provider with no key refuses to run — never a silent swap
✔ registry: forceFake is the only way to get the offline provider
✔ openai adapter: baseline shape, and direct-transport 0G provenance comes from x_0g_trace
✔ openai adapter: tool calls are normalized to {id,name,input}
✔ anthropic adapter: system goes top-level and tools use input_schema
✔ anthropic adapter: a tool_result block is emitted for tool messages
✔ google adapter: contents/parts and functionDeclarations
✔ fake provider: reports itself as fake so a demo cannot mistake it for real
✔ openai adapter on the meter transport: provenance comes from x_meter and binds a payment
ℹ tests 17  ℹ pass 17  ℹ fail 0
```

`tsc --noEmit` clean. Adapter tests use an injected `fetchImpl` — no network, no keys, no cost.

### Two of these tests initially failed, and the code was right

Worth recording because it shows the tests were checked against reality rather than written to pass:

1. **I assumed the adapter preferred `X-0G-Request-Id` header over the trace block.** It does not, on the direct transport. Checking the source: `provenanceOf()` reads `x_0g_trace` for `direct` and `x_meter` for `x402-meter`. That is **correct** — a direct call pays nobody, so there is no payment tx to bind, and the trace block is what 0G documents for a direct call. My test was corrected, and a **new test was added for the meter path**, which is where payment binding actually happens.
2. **I assumed the fake provider's ids were prefixed `dev-`.** They are `fake-req-…`. Keeping them distinct is right: `dev-` belongs to the meter's offline upstream, and the two must be distinguishable in a ledger. Test corrected.

Neither was a code bug; both were stale assumptions in the test. The tests now assert the real, documented behaviour.

## What is real vs mocked

| Real, tested | Written, never executed |
|---|---|
| config validation, availability reporting, registry refusal semantics, all four adapters' request/response translation, meter provenance binding | **every adapter against a real vendor.** All HTTP is stubbed. No 0G, OpenAI, Anthropic or Gemini key has been used, and the `payer` has never settled anything |

## Next

Step 09: the fence and the budget — the two guards that stop the model from being fooled and from overspending.
