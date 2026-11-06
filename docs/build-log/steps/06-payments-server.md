# Step 06 — the HTTP server

**Commit:** `feat(payments): http server wiring the paywall, meter and discovery routes`
**Author:** Rajarshi
**Files:** `payments/src/server.ts`, `payments/src/index.ts`, `payments/test/server.test.ts`

## Why

Steps 02–05 built parts that are tested but unreachable. This step wires them into a real process and makes the package's whole surface inspectable — including two routes whose only purpose is to make the project *verifiable by a judge*: `/.well-known/x402` and `/split-preview`.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/ask` | POST, GET | fan pays artist → steward answers. GET allowed so a demo question can be pasted into a browser bar |
| `/meter/v1/chat/completions` | POST | agent pays per inference call |
| `/meter/info` | GET | price + budget + upstream, for the steward to self-configure |
| `/meter/v1/models` | GET | free catalog passthrough — a client must know the model name *before* paying |
| `/.well-known/x402` | GET | machine-readable discovery at the standard location |
| `/split-preview?amount=` | GET | the 96.31 / 3.69 arithmetic for any amount, for the UI |
| `/ledger/recent` | GET | tail of the HCS-backed spend log |
| `/health` | GET | liveness **and which mode/gate is live** |

No router library. `node:http` plus a `switch` is the most readable possible router in a diff, and five routes do not justify a dependency tree.

## `createApp()` vs `start()`

The split is the reason the test suite has no port juggling:

| Function | Does | Used by |
|---|---|---|
| `createApp(cfg)` | builds the server, **does not listen** | tests, and `start()` |
| `start()` | reads env, builds, `listen()`s, logs | `node src/server.ts` |

The bottom of the file guards `start()`:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
```

**Importing a module must not open a port.** Without this guard, any test that imported `server.ts` would bind 8402 and the suite would fail on a second run.

## Details worth reviewing

| Detail | Why |
|---|---|
| CORS exposes `x-payment-response` | the frontend is a **browser** app. Without this header it cannot read the settlement receipt even though the request succeeds — a demo that works in curl and fails on screen |
| `access-control-allow-headers: x-payment` | the browser must be *allowed to send* the payment header |
| `OPTIONS` → 204 | preflight, answered before any routing |
| Body ceiling → 400 | a body over 256 KB surfaces as a clean 400 from the `readBody` catch, not an unhandled rejection |
| `res.headersSent` guard in the catch | a handler may have already begun a response; writing a second one throws |
| `GET /ask` allowed | demo convenience; POST is the real path |
| `/health` reports `gate` and `mode` | a teammate can tell at a glance whether they are looking at a mock or a real settlement run |
| `/.well-known/x402` has no secrets | asserted in a test that the serialised body contains no `Bearer` |
| `/split-preview` uses `Number()` | a demo-scale preview only; the charged value is always `priceAtomic` |

`src/index.ts` is now the explicit **contract between `payments/` and `agent/`**. The export list is deliberately narrow — gate internals and ledger parsing are not exported, because widening the surface would make the two packages harder to separate, not easier.

## Verification

```bash
cd payments && npm test && npx tsc --noEmit
```

```
✔ server: /health reports the mode gate and network, so mock vs real is obvious
✔ server: /.well-known/x402 advertises both prices and the right payees
✔ server: /split-preview computes the advertised split for any amount
✔ server: GET /ask gets a 402 with CORS headers a browser can read the receipt from
✔ server: OPTIONS is answered 204 for the browser preflight
✔ server: wrong method on the meter is a 405 that points at the right one
✔ server: an unknown path is a 404 that lists what does exist
✔ server: a body over the 256 KB ceiling is a 400, not a crash
✔ server: /ledger/recent is empty on a fresh run and totals are zero
ℹ tests 39  ℹ pass 39  ℹ fail 0
```

(9 new + 30 from steps 02–05.) `tsc --noEmit` clean.

### And it really boots

Tests prove the router; this proves the process. Ran the advertised command and hit it with curl:

```
$ PORT=8499 node src/server.ts
{"level":"info","msg":"payments listening","port":8499,"mode":"dev","gate":"mock",
 "network":"hedera:testnet","ask":"0.100000 USDC","meter":"0.002000 USDC"}

$ curl -s localhost:8499/health
{ "ok": true, "mode": "dev", "gate": "mock", "network": "hedera:testnet",
  "asset": "0.0.429274", "split": { "artist": 9631, "agent": 369 }, "uptimeSec": 3 }

$ curl -o /dev/null -w '%{http_code}' "localhost:8499/ask?q=who+are+you"
402

$ curl -s localhost:8499/.well-known/x402
{ "x402Version": 2, ..., "resources": {
    "/ask":                        { "priceAtomic": "100000", "payTo": "0.0.5555" },
    "/meter/v1/chat/completions":  { "priceAtomic": "2000",   "payTo": "0.0.6666" } } }
```

Per-request structured logs on every call. The split, the prices and the two payees are all visible over HTTP without reading the source.

## What is real vs mocked

| Real, tested | Mocked at this step |
|---|---|
| routing, CORS, preflight, size ceiling, discovery document, `createApp`/`start` separation | gate is `mock`; upstream inference is the dev stand-in. Still no network, keys or chain |

## Next

Step 07: `payments/README.md` and `scripts/create-tip-token.ts` — the HTS fractional fee, i.e. where this split lives on-chain for real.
