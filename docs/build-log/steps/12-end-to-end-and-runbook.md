# Step 12 — end-to-end demo, runbook, ideation record

**Commit:** `docs: end-to-end demo verification, RUNBOOK and AGENT-IDEATION`
**Author:** Rajarshi
**Files:** `docs/RUNBOOK.md`, `docs/AGENT-IDEATION.md`, `docs/build-log/PLAN.md`

## Why this is last

The previous eleven steps each proved one piece. This step is the first one that proves **the pieces work together**, with both services running at once — and it is the step where the honest limits get written down rather than discovered by a judge.

## The whole loop, actually executed

Both services were started locally (`PAYMENTS_MODE=dev`, `STEWARD_MODE=fake`, agent on the `x402-meter` transport) and `node agent/scripts/demo.ts` was run:

```
1. services───────────────────────────────────────────────────────
✔ payments  mode=dev gate=mock asset=0.0.429274
✔ steward   provider=local model=0gm-1.0-35b-a3b transport=direct

2. fan asks without paying────────────────────────────────────────
HTTP 402 ⸺ 100000 atomic 0.0.429274 → payTo 0.0.5555

3. fan pays, steward answers──────────────────────────────────────
Q: Who are you and what do you play?
A: (fake steward) I checked — get_artist_profile: {...} | get_songs: {...} | quote_tip: {...}
   via 0g/0gm-1.0-35b-a3b

4. the proof judges ask for───────────────────────────────────────
split          : 0.100000 -> 0.096310 artist / 0.003690 agent
payment tx     : mock-mw4r1e47-xtawhc
HashScan       : https://hashscan.io/testnet/transaction/mock-mw4r1e47-xtawhc
0G request id  : fake-req-mw4r1e3i
TEE verified   : (not requested)
HCS spend log  : hcs-mock-b717ece4e4f76bbc

5. the agent paid for its own thinking────────────────────────────
ask   0.100000 USDC  payer=0.0.7777  tx=mock-mw4r1e47-xtawhc  req=fake-req-mw4r1e3i
total through the rails: 0.1 USDC over 1 calls
```

### Three things this run proves that unit tests cannot

**1. The payment tx id and the upstream request id are bound together.**

```
payment tx     : mock-mw4r1e47-xtawhc
0G request id  : fake-req-mw4r1e3i
```

appear on the **same** ledger line:

```json
{"kind":"ask","txId":"mock-mw4r1e47-xtawhc","priceAtomic":"100000",
 "payer":"0.0.7777","upstreamRequestId":"fake-req-mw4r1e3i","teeVerified":null}
```

That binding is the answer to *"how do we know the inference you paid for is the one that answered?"* — the proof only exists because the whole chain ran.

**2. The split lands exactly on the promise.** `0.100000 → 0.096310 / 0.003690` — 96.31% / 3.69%, integer arithmetic, no float drift.

**3. The budget gate refuses with a *scope*, live.** A separate call to the meter after the fan's payment:

```json
{ "error": "SPEND_CAP_EXCEEDED", "code": "SPEND_CAP_EXCEEDED", "scope": "hourly",
  "spentLastHourUsd": 0.1, "capUsd": 0.05 }
```

`scope: "hourly"` is exactly the value step 10's steward reads to decide *degrade to a free template reply* rather than error. The two services agree on the vocabulary because they were designed against each other, not wired up afterwards.

## What was added

| File | Why |
|---|---|
| `docs/RUNBOOK.md` | fresh clone → settled transaction, dev mode in 60 seconds, live mode with the three account roles spelled out |
| `docs/AGENT-IDEATION.md` | the design record: why a provider abstraction, why the fence, why no money-moving tool, what was rejected |
| `docs/build-log/PLAN.md` | steps 08–12 marked done |

`RUNBOOK.md` opens by claiming *"if something here does not work, that is a bug in the repo, not in your machine"* — which is only honest because the dev-mode path now has an executed transcript behind it.

## What is still not executed — the honest table

| Path | Status |
|---|---|
| Split arithmetic, ledger, budget ceilings, fence, provider parsing, tool loop | **real code, tested** |
| 402 challenge shape, verify → serve → settle ordering | **real protocol shape, mock facilitator** |
| x402 settlement on Hedera testnet | **written, never executed** — no credentials in this environment. `docs/TX-PROOF.md` stays empty until a real testnet tx settles |
| 0G inference (and its TEE attestation) | **written, never executed** — the `fake` provider is the offline default |
| HTS fractional-fee token | **script written, never run** |
| Every real vendor adapter (OpenAI, Anthropic, Gemini) | **written, never executed** |

This table is the single most important thing in the step. The demo output above says `(fake steward)` and `mock-…` and `fake-req-…` in plain sight — a reader cannot mistake it for a live settlement.

### Why `TX-PROOF.md` is still empty

It is the file that will hold the first real HashScan transaction id. Writing a placeholder there would be the one lie that undoes every honest label in this log, so it stays empty until a transaction actually exists.

## Verification

```bash
npm run test        # both packages
npm run typecheck
node agent/scripts/demo.ts
```

```
payments: 39/39 pass      agent: 42/42 pass      total 81
tsc --noEmit clean in both packages
demo: full transcript above, exit 0
```

## Where this leaves the series

Twelve commits, each individually green, each with a step doc and a PR. The diff a reviewer reads in `docs/build-log/steps/` matches the commits one-to-one, so the owner can cherry-pick any single step.
