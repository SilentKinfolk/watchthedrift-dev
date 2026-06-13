---
description: Catch up on the repo state, then work exactly ONE unblocked ready-for-agent GitHub issue to completion
---

You are one iteration of an autonomous build loop on this repo (**watchthedrift-dev**
— the v2 experimentation ground for watchthedrift). You may have a fresh context:
catch up first, then work exactly **one** issue to completion, then report and
stop. Think as hard as the work demands before acting.

If a line `RUN_ID: <id>` appears at the top of this prompt, that is your claim id;
otherwise invent one (`loop-<UTC timestamp>`).

## Phase 1 — Catch up (every time, before picking work)

1. Read **SPEC.md** — the directional spec / north star for v2. Read **PLAN.md**
   too if it exists (the design authority, once the direction is sharpened).
2. Read the **PRD**: `gh issue view 1` (the PRD published by the `/to-prd` skill).
   If #1 is not the PRD, find it: `gh issue list --label prd` or the pinned issue.
3. Read what landed before you: `gh issue list --state closed --json number,title`,
   then `gh issue view <n> --comments` for every closed implementation issue —
   comments record scope changes, partial landings, and findings that never made
   it into the issue body.
4. Skim the git history — it is dense by design: `git log --oneline`, then read
   the full bodies of the last ~10 commits (`git log -10`) and of any commit
   touching the area you are about to work.
5. Read the code: the `src/` tree, `tests/`, and any `docs/` are small — read
   them. (Early on this repo may be near-empty; the first issues scaffold it.)
6. Follow **CLAUDE.md** (auto-loaded if present) and the global commit methodology
   to the letter.

## Phase 2 — Work exactly one issue

1. **Pick:** `gh issue list --label ready-for-agent --state open` → take the
   lowest-numbered issue whose "Blocked by" issues are ALL closed
   (`gh issue view <n>` to check). Skip any issue with an unresolved claim comment
   newer than 24 h.
2. **Gate check:** never take an `hitl`-labelled issue. If the ONLY remaining
   unblocked work is an `hitl` gate, do not start anything: report status `gate`
   and tell the operator exactly what the gate requires and how to clear it.
3. **Claim:** comment `Claiming — <RUN_ID>` on the issue.
4. **Build:** branch `issue-<n>-<short-slug>`. Implement to the issue's acceptance
   criteria — they are the definition of done. SPEC.md (and PLAN.md / the PRD once
   they exist) is the design authority; if the issue conflicts with it, comment on
   the issue, do not improvise, and report status `blocked reason=conflict`.
5. **Verify:** once a `package.json` exists, `npm ci` then `npm run build` (tsc
   typecheck + vite build) and `npm test` (Vitest) MUST pass — they are the gate.
   For a change that affects the running app, confirm it actually works (build the
   preview / follow the repo's verify steps), not just that the types pass. Tick
   the acceptance boxes only for what you actually verified.
6. **Land:** push, `gh pr create` with `Closes #<n>` in the body, merge when CI is
   green (a merge commit, **never squash** — the dense history is the point),
   confirm the issue auto-closed, delete the branch. If the repo has no CI workflow
   yet, verify locally (step 5) before merging.
7. Commit style: frequent, dense, self-explanatory messages; co-author trailer on
   every commit.

**Headless execution — there is no later wake-up.** You run non-interactively
(`claude -p`): your turn ends the moment you stop calling tools, and any task you
started with `run_in_background` is abandoned when the process exits — nothing
resumes you when background work finishes. Never end a turn waiting on async work
to "signal completion": either drive it to completion in this turn (block or poll
until done), or, if it genuinely cannot finish in budget, report
`LOOP_STATUS: blocked issue=<n> reason=other` describing what is pending. A turn
that ends with no status line stalls the loop and needs an operator.

If a permission denial blocks the critical path (push / PR / merge) and you cannot
complete the issue without it, leave the work committed on its branch, comment the
state on the issue, and report status `blocked reason=permission`. If anything else
fails in a way you cannot fix within the issue's scope, comment your findings on
the issue and report status `blocked` rather than thrashing.

## Phase 3 — Report and stop (mandatory)

Your final message is the ONLY thing the operator sees (they follow detail on the
issue tracker): make it a concise completion report — what landed, PR number,
verification results, anything notable for the next agent.

End the message with exactly ONE status line as the LAST line, plain text, no
formatting:

- `LOOP_STATUS: completed issue=<n> pr=<n>` — issue closed, PR merged, CI green
- `LOOP_STATUS: no-work` — nothing unblocked and no gate pending
- `LOOP_STATUS: gate issue=<n>` — an `hitl` gate is the only unblocked work
- `LOOP_STATUS: blocked issue=<n> reason=permission|conflict|verification|other`

Never invent a different status shape — the loop runner parses this line. If
unsure, use `blocked … reason=other` and explain above it.
