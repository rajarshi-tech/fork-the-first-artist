# Build Log

Step-by-step record of the `agent/` + `payments/` work, rebuilt as small reviewable commits.

| File | Purpose |
|---|---|
| [`PLAN.md`](./PLAN.md) | The 12-step plan, scope, design rules, verified ground truth, done-criteria |
| [`LOG.md`](./LOG.md) | Append-only log: one row per event, who did what, when, test counts |
| `steps/NN-*.md` | One doc per commit: what changed, why, how it was checked, what is still mocked |

**Author of every commit in this series:** Rajarshi (`rajarshi-tech <rajarshi-tech@users.noreply.github.com>`).
No other person, model or tool is credited as an author. AI assistance is disclosed in the package READMEs per the team rule "AI help disclosed".

## Reading order

Start with `PLAN.md` (the plan), then `LOG.md` (the chronology), then the step docs in numeric order.
Each step doc is self-contained: it names the files, the reasoning, the verification command and its result.

## Why the rebuild

The first attempt was one commit of 51 files (`12857fa`). It worked but could not be reviewed or cherry-picked by the owner, who re-implements our diff into his real repo. The old commit is preserved as a git bundle and a patch under `.backup/` (never committed).
