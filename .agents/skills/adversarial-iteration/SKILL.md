---
name: adversarial-iteration
description: >
  Use when iterating on a fix after an adversarial code review (Codex, human
  reviewer) surfaces design-level findings — not typos, lint, or formatter work.
  Frames the review/fix loop as implement -> [review -> REFLECT -> reproducer ->
  fix -> verify -> handoff] where each round runs in a fresh agent to prevent
  context accumulation. Provides a four-item cheap-checks list (timeline draw,
  upstream contract read, full lifecycle trace, variant enumeration) that catches
  recurring failure classes. No git commits during the loop — all changes commit
  together after zero-finding termination. Trigger when a review pass surfaces
  2+ findings on a single change, when sibling bugs of an "already-fixed" issue
  keep appearing across rounds, or when the user asks "why did I miss this?".
  Do NOT use for single-line fixes where the cause is obvious from the diff,
  or for initial implementation work (use CLAUDE.md rules).
---

# Adversarial Iteration

Work *with* adversarial review feedback instead of patching symptoms.

## The loop

```
implement -> [spawn round agent -> review -> REFLECT -> reproducer -> fix -> verify -> return summary] --+
               ^                                                                                          |
               +-------- next round (fresh agent, clean context, re-reads files from disk) <--------------+

  terminates when round agent reports ZERO_FINDINGS.
```

Step 1 (implement) is manual. Steps 2+ run inside `/loop` autonomously —
no `AskUserQuestion`, `ExitPlanMode`, or other user gates. When multiple
approaches exist, tag one "Recommended", pick it, continue. The user can
interrupt at any point; you never pause to ask.

If agents are unavailable, run the next review inline and re-read all
changed files before reviewing.

## REFLECT

The unique step. Skipping it produces fixes that pass the named test but seed
the next finding in the same class.

For each finding, answer:

1. **What did I do wrong?** One sentence, no euphemisms.
2. **Why did I miss it?** Name the assumption encoded without verifying.
3. **Which `CLAUDE.md` rule did I violate?** Be specific.
4. **What cheap check would have caught it?** (see next section)

Then across all findings: *what's the unifying shape?* Often a single cognitive
failure caused them all. Name it.

Common shapes:

- **Solved the named problem, not the invariant.**
- **Yes-manned own design** — round-1 yes-mans the user; round-2 yes-mans yourself.
- **Generic abstraction without per-instantiation audit.**
- **Layer-ownership leak via assumed invariant.**
- **Tunnel vision on per-unit fix, missed system-level cooperation.**

If reflection produces a new shape, add it to this list.

## Cheap checks (do all four before writing fix code)

1. **Timeline draw** — For concurrent state changes, draw the interleaved
   timeline. Find the check-act gap. Two cooperating booleans is almost always
   wrong; use `Once`, `compare_exchange`, or a single owner.

2. **Upstream contract read** — For any value flowing in, read the producer's
   contract (grep, 5 lines). Don't assume from the type name. Ask: does this
   transformation belong in this layer?

3. **Full lifecycle trace** — For any fix depending on component cooperation,
   trace init through teardown. List every component and what happens to
   in-flight work. Especially: what stops first?

4. **Variant enumeration** — For any generic covering N types, list each
   type's destructor/serializer/contract. Verify the generic satisfies every
   one. If they differ non-trivially, prefer N type-specific wrappers or
   parametrize over a closure.

## Reproducer test

Write the test **before** the fix. Verify it FAILS on unfixed code — if it
passes, it's a tautology. The test must touch the *system* the bug lives in,
not just a helper in isolation. Do not commit yet; all changes commit together
after the loop terminates.

## Plan-mode discipline

Draft a plan (in the response, not via `ExitPlanMode`) referencing:

1. The REFLECT root-cause shape this fix addresses.
2. The reproducer test (file + function) and its assertion.
3. Which cheap check identified the design constraint.
4. The chosen primitive and why it's the smallest satisfying change.
5. Adjacent contracts that also need tests.

## Verify

- Reproducer flips red -> green (necessary, not sufficient).
- Adjacent-contract tests from REFLECT also pass.
- If the next review surfaces a sibling of the same finding, REFLECT wasn't
  deep enough — go back to REFLECT, don't just patch.

## Round handoff (MANDATORY — blocks next round)

Do NOT commit during the loop. All changes accumulate as working-tree edits
and are committed once after the loop terminates with zero findings.

After verify passes, do these IN ORDER before spawning the next round.
Skipping any one is a protocol violation.

### 1. Audit comments

`grep -rn 'round\|TODO.*round\|HACK\|FIXME\|debugging\|TEMP' <changed files>`.
Remove round-N narrative, debugging scaffolding, and stale TODOs from the
working tree before the next agent reads those files.

### 2. Build round summary

Construct this structured summary for the orchestrator to carry forward:

```
### Round N complete
- Findings: <list of what the review surfaced>
- Root-cause shape: <the REFLECT unifying shape>
- Fixes: <what changed and why, 2-3 sentences max>
- Files changed: <paths>
- Tests: pass/fail
- Remaining risk: <anything REFLECT flagged but did not address>
```

### 3. Spawn fresh agent for next round

Read [references/round-agent-prompt.md](references/round-agent-prompt.md)
for the agent prompt template. Populate it with:

- The round number
- All accumulated prior round summaries
- The list of changed files

Spawn a **general-purpose agent** (not codex:rescue — the round agent needs
Read/Write/Edit/Bash for the full REFLECT->fix cycle). The fresh context
window is the compaction mechanism — no `/compact` needed.

The agent runs its full round (review -> REFLECT -> reproducer -> fix ->
verify) and returns a structured round summary. The orchestrator evaluates
whether the summary contains `ZERO_FINDINGS`.

## Termination

The loop ends when **all three** hold:

1. Latest round agent reports `ZERO_FINDINGS` after re-reading all changed files.
2. Every finding has a reproducer test, verified green.
3. Every adjacent-contract test from each REFLECT passes.

No other exit. Sibling findings recurring -> previous REFLECT was too shallow,
go back to REFLECT. Fix getting expensive -> plan the architectural change as
this iteration's step, same loop. Never propose "stop here, accept risk."

## Anti-patterns

- **Reflection-as-apology.** "Should have been more careful" is not a root
  cause. "Never read `ExecStdout::next`" is.
- **Test polarity flip.** If the test was green on broken code, it's
  confirmation bias, not a reproducer.
- **One reproducer, no class coverage.** If reflection identified 6 types and
  only one has a test, the next review finds the other 5.
- **Treating review as checklist.** The review surfaces symptoms; REFLECT finds
  the design choice that produced them all.
- **Skipping agent spawn.** Running the next review in the same context instead
  of spawning a fresh agent. Accumulated context degrades review quality and
  wastes tokens. The pull to "just run the review here" is strong — resist it.
  A new agent re-reads files from disk, not from stale cached content.
- **Bloated round summaries.** Including full diffs or debug traces in the
  round summary defeats the purpose. The summary is compressed signal, not a
  transcript. Five lines per round, not fifty.

## This project's codebase

- Adversarial review: `/codex:adversarial-review`
- Loop runner: `/loop` (dynamic-pacing, omit interval)
- Commit pattern: all changes commit together after zero-finding termination;
  conversation history is the iteration audit trail.
