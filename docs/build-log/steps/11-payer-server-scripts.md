# Step 11 — the payer, the HTTP face and the scripts

**Commit:** `feat(agent): x402 payer, HTTP server, smoke + demo scripts`
**Author:** Rajarshi
**Files:** `agent/src/rails/payer.ts`, `agent/src/server.ts`, `agent/src/http.ts`, `agent/src/index.ts`, `agent/scripts/smoke.ts`, `agent/scripts/demo.ts`, `agent/package.json`, `agent/tsconfig.json`

## Why these together

This step turns the library into a running service. The payer is included because `index.ts` — the assembly point — has to decide **whether the agent has a wallet at all**, and that decision is the most important safety statement in the agent.

---

## `rails/payer.ts` — the wallet

### Why it wraps `fetch` instead of being called explicitly

**The steward does not know it is paying.** It calls a provider; the provider calls `payer.fetch`; the `402 → sign → retry` handshake happens inside the wrapper. That is the x402 model — payment is a *transport concern*.

It is also a security property: the payment code has **exactly one entry point**, and there is no `pay()` function for a prompt injection to invoke. A model cannot reach the wallet.

### Two independent spend ceilings

| Where | Protects against |
|---|---|
| `setSpendControls` (client) | one payment exceeding `maxAmountPerPayment` |
| `payments/src/meter.ts` budget gate (server) | the steward's *total* spend over time |

**Neither is sufficient alone.** The client cap cannot see history; the server gate cannot stop a compromised client. Both are checked.

### The two payers

| `kind` | When | What it does |
|---|---|---|
| `mock` | no `HEDERA_AGENT_PRIVATE_KEY` | sends `x-payment: mock payer=…`; the meter in `PAYMENTS_MODE=dev` accepts it. Whole loop runs offline, zero credentials. |
| `hedera` | key present | real x402 on a 402: sign a partially-signed `TransferTransaction`, retry with `X-PAYMENT`, facilitator settles |

### Two deliberate details

```ts
const first = await fetch(url, init);
if (first.status !== 402) return first;
```

A metered endpoint answers `402`. Anything else — `200`, `500`, a socket error — is **passed through untouched**, so a non-payment failure is never swallowed by the payment path. Only `402` triggers signing.

```ts
// Sign exactly what the server asked for.
const paymentPayload = await client.createPaymentPayload({ x402Version, accepts });
```

We do **not** invent payment requirements; we echo `accepts` back signed. A server asking for an asset outside the proxy allowlist is refused by `setSpendControls`, not by us — the refusal is not ours to implement.

### Lazy imports are load-bearing

`@x402/core`, `@x402/hedera` and `@hiero-ledger/sdk` are **`optionalDependencies`** and are `import()`ed dynamically. A dev-mode checkout installs none of them and still runs. Only an operator who configured a key pays the install cost — and gets an error naming all three packages if they are missing.

> **Status: written, never executed.** The Hedera branch has never run against a real network. `docs/TX-PROOF.md` stays empty until a real testnet transaction settles.

---

## `src/index.ts` — the assembly point, and the safety statement

```ts
const payer =
  opts.payer ??
  (transport === 'x402-meter' || process.env.HEDERA_AGENT_PRIVATE_KEY
    ? await createPayer()
    : undefined);
```

**No key and no metered transport → no payer object at all.** The agent physically cannot pay anything. It is not a flag that could be flipped; there is no wallet to use. This is stronger than "payments are disabled by default".

### `loadArtist` merge order

```ts
return { ...DEMO_ARTIST, ...raw };
```

A partially-filled `artist.json` inherits sane defaults instead of producing `undefined` fields. Note the consequence: a missing `consent` field inherits `true`. Correct for the demo, and explicitly overridden in production configs.

### One source of truth for the demo artist

`DEMO_ARTIST` moved out of `index.ts` into `demo-artist.ts` (step 10) and `index.ts` now imports and re-exports it. Rejected alternative: keeping a second copy in `index.ts` — that is how a test and the running server end up disagreeing about who the artist is.

---

## `src/server.ts` — three routes

| Route | Purpose |
|---|---|
| `GET /health` | liveness + which provider/model/tools are actually live |
| `GET /agent-card` | machine-readable description: artist, agent, **every** provider with a `usable` flag and the reason it is not |
| `POST /ask` | the one route the paywall uses |

### `/agent-card` honesty is the feature

Live output from the real boot:

```json
{ "id": "0g", "usable": true,  "note": "no wallet key: dev/mock payment", "isDefault": true }
{ "id": "openai", "usable": false, "note": "OPENAI_API_KEY is not set" }
{ "id": "anthropic", "usable": false, "note": "ANTHROPIC_API_KEY is not set" }
```

A demo that silently degraded to the fake provider would look **identical** to one that works. The `note` string is the difference.

### Two decisions

| Decision | Reason |
|---|---|
| Refusals are `422`, not `500` | bad request / no consent / unsupported capability is the client's problem, not a server fault |
| listen only when executed directly, via `import.meta.url === pathToFileURL(argv[1]).href` | importing the module from a test must not open a socket; compared via `pathToFileURL` because a naive string compare of Windows paths fails |

`src/http.ts` is duplicated from `payments/src/http.ts` **on purpose**: each folder must stand alone, because the repo owner merges them separately into the real codebase.

---

## `scripts/`

- `smoke.ts` — one request through the whole agent, prints the envelope. Uses the fake provider.
- `demo.ts` — the end-to-end story across both services (agent + payments).

---

## Verification

Typecheck and unit tests:

```bash
cd agent && npm test && npx tsc --noEmit
```
```
ℹ tests 42  ℹ pass 42  ℹ fail 0
```
`tsc --noEmit` clean.

**Real boot** (`STEWARD_MODE=fake PORT=8411 node src/server.ts`), then curl:

```
GET /health   → 200 {"ok":true,"provider":"local","model":"0gm-1.0-35b-a3b",
                     "tools":["get_artist_profile","get_songs","quote_tip"],...}
GET /agent-card → 200 providers[0] = 0g usable:true note:"no wallet key: dev/mock payment"
                        providers[1] = openai usable:false note:"OPENAI_API_KEY is not set"
POST /ask     → 200 ok:true, 3 tool calls executed, provenance.requestId = fake-req-…
GET /nope     → 404 NOT_FOUND
```

The `/ask` response proves the whole chain end to end: the fake provider asked for all three tools, the registry executed them, `quote_tip` returned `artistAtomic 96310 / agentAtomic 3690` for 0.10, and the envelope carries `provenance.requestId`.

## What is real vs mocked

| Real, executed | Written, **never executed** |
|---|---|
| server boot, all three routes, the CLI guard, tool loop through the fake provider, `/agent-card` availability reporting | the Hedera payer's 402→sign→settle handshake; any real vendor adapter |
| typecheck + 42 unit tests | — |

Note the `/health` line above reports `provider: local` while `/agent-card` says `0g` is the default — that is the *fake* serving the `local` entry under `STEWARD_MODE=fake`, not a provider swap in disguise.

## Next

Step 12: the end-to-end demo story, `RUNBOOK.md`, `AGENT-IDEATION.md` and the root scripts.
