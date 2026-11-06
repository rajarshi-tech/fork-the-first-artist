# Step 01 — root scaffolding

**Commit:** `chore(repo): root scripts, ignore rules, line-ending policy`
**Author:** Rajarshi
**Files:** `.gitignore`, `.gitattributes`, `package.json`

## Why

Three root files had to exist before any package: a place to run the whole thing from, an ignore file that does not eat the `.env.example` templates, and a line-ending policy so a Windows/macOS team gets identical diffs.

## What changed

### `package.json` (new)

Root scripts only — no dependencies. Every package is installed and run with `--prefix`, so the root stays a thin dispatcher and nothing has to be hoisted.

```json
"test":      "npm --prefix payments test && npm --prefix agent test"
"typecheck": "npm --prefix payments run typecheck && npm --prefix agent run typecheck"
"demo":      "node agent/scripts/demo.ts"
```

`engines.node >= 22.18` is not decorative: both packages are plain `.ts` files run directly by Node's own TypeScript stripping. There is no build step anywhere in this repo — that is deliberate, it keeps the diff the owner has to re-implement small and keeps `node src/index.ts` honest.

### `.gitignore` (modified)

The skeleton had `.env` and `.env.*`. That silently swallowed `payments/.env.example` and `agent/.env.example` — the templates that tell a teammate which variables exist. Fixed with an explicit negation placed **after** the ignore rule (git discards a path on the first matching rule, so order matters):

```gitignore
.env.*
!.env.example
```

Also added:

| Rule | Reason |
|---|---|
| `payments/data/*.jsonl`, `agent/data/*.jsonl` | the spend ledger and budget file are runtime state. Committing them makes every demo dirty the tree. |
| `*.log` | service logs |
| `.backup/`, `pi-session-*.html` | local scratch; the original squashed commit is preserved here for audit and must never be pushed |

### `.gitattributes` (new)

```gitattributes
* text=auto eol=lf
```

Without this, a Windows checkout writes CRLF and every commit shows a whole-file diff for the macOS teammates. One line, prevents the single most annoying class of merge conflict in a mixed-OS team.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"   # valid JSON
git check-ignore -v .backup/orig                                          # .backup/ is ignored
```

Both pass. No tests exist yet at this step — nothing executable has been added.

## Note on the `.env.example` fix

This was a real bug found in the previous attempt (the templates were missing from `git status`), not a rewrite for style. The negation line is why `git status` later shows `?? payments/.env.example` instead of nothing.

## Next

Step 02: `payments/` config and the atomic money math — the split must conserve value before anything touches a chain.
