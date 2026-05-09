---
name: adversarial-iteration
description: >
  Use when iterating on a fix after an adversarial code review (Codex, human reviewer)
  surfaces design-level findings — not typos, lint, or formatter work. Frames the
  review/fix loop as implement -> [review -> REFLECT -> reproducer-commit -> plan-mode
  fix -> verify -> COMPACT] driven by `/loop` until the review surfaces zero findings.
  Provides a four-item cheap-checks list (timeline draw, upstream contract read,
  full lifecycle trace, variant enumeration) that catches recurring failure classes,
  and a COMPACT step (squash test+fix, audit round-N narrative out of comments,
  tree-identity check) that runs at the END OF EACH ROUND so the next review reads
  canonical code, not a debugging notebook. Trigger when a review pass surfaces 2+
  findings on a single change, when sibling bugs of an "already-fixed" issue keep
  appearing across rounds, or when the user asks "why did I miss this?". Do NOT
  use for single-line fixes where the cause is obvious from the diff, or for
  initial implementation work (use CLAUDE.md rules).
---

# Adversarial Iteration

A loop for working *with* adversarial review feedback instead of just patching to make findings go away.

## The loop

```
              +----------------------- one round -----------------------+
              |                                                         |
implement -> review -> REFLECT -> reproducer -> fix -> verify -> COMPACT --+
              ^                                                            |
              |                                                            |
              +----------- next round (review the compacted state) <-------+

  loop terminates when review surfaces zero findings AFTER compaction.
```

The unique step is **REFLECT** — skipping it produces fixes that pass the named
test but seed the next finding in the same class.

The often-skipped step is **COMPACT** — every round closes with squash + comment
audit + tree-identity check *before* the next review. The next review then reads
canonical code, not a debugging notebook, and any "round-N+1 reverses round-N"
fold is a one-commit operation.

## Step 1 -- REFLECT (root cause, not symptom)

For *each* finding, write one paragraph answering all four questions:

1. **What did I do wrong?** One sentence, no euphemisms.
2. **Why did I miss it?** Name the cognitive shortcut: which assumption did I encode without verifying?
3. **Which `CLAUDE.md` rule did I violate?** Be specific (#0 yes-man, #3 search-first, #5 DRY, #7 minimal knowledge, #14 idiomatic, etc.).
4. **What cheap pre-action would have caught it?** A 5-10 minute read or sketch you skipped.

Then look across **all** findings together and ask: *what's the unifying shape?*
Often a single cognitive failure caused all of them. Name it.

Common shapes seen on this codebase:

- **Solved the named problem, not the invariant.** "Exit fires after streams" is not the same as "Exit fires exactly once."
- **Yes-manned own design.** Round-1 yes-mans the user; round-2 yes-mans yourself.
- **Generic abstraction without per-instantiation audit.** `OwnedFfiPtr<T>` works for `CBoxHandle`, leaks for `CImagePullResult` (which has nested `CString::into_raw` members).
- **Layer-ownership leak via assumed invariant.** Treating raw byte chunks as line-terminated text in the wrong layer.
- **Tunnel vision on per-unit fix, missed system-level cooperation.** Synthetic-Exit-in-Rust assumes the Go drain goroutine is alive — but `Runtime.Close` already killed it.
- **"Wait observed" conflated with "event happened."** A `wait_on_clone` that returned (Ok or Err) is not proof the awaited process exited. Round-7 wrote the flag unconditionally; round-8 had to revert to `if result.is_ok()`. When two semantics share one flag, the next round will find the case that distinguishes them.
- **One flag, multiple writers, not all writers update it.** Sibling of the above. If state X gates path A's behaviour, every path that *could* observe X must update X. Variant-enumerate the writers.

If reflection produces a *new* shape, add it to this list.

## Step 2 -- Pre-implementation cheap checks

Before writing any fix code, do **all four**:

### Timeline draw (catches race conditions / TOCTOU)

For any concurrent state change involving 2+ tasks/goroutines/threads, draw the
interleaved timeline. Find the gap between check and act. Ask:
*who has the right to do X, and how do they atomically claim it?*

Two cooperating boolean flags is almost always wrong. The right primitive is
`Once`, `compare_exchange`, or a single owner.

### Upstream contract read (catches layer-ownership leaks)

For any value flowing in, read what the producer's contract actually is. Don't
assume from the type name (`ExecStdout` doesn't mean "lines of text"). `grep`
the producer, read 5 lines. If your code is transforming the value, ask: *does
this transformation belong in this layer, or am I duplicating something the
producer should do (or already does)?*

### Full lifecycle trace (catches scope tunnel)

For any fix that depends on cooperation between components (Rust <-> Go,
producer <-> consumer, init <-> shutdown), trace the *complete* lifecycle
including teardown. List every component in order and what happens to in-flight
work at each stage. Especially: *what stops first*?

### Variant enumeration (catches generic-too-narrow)

For any generic wrapper covering N types, list each `T_i` and write down its
destructor / serializer / contract obligation. Verify the generic impl satisfies
*every* one. If they differ in non-trivial ways, the abstraction is wrong-shaped
-- prefer N type-specific wrappers, or parametrize the generic over a closure
that captures the type-specific behavior.

## Step 3 -- Reproducer-first

- Write the reproducer test **before** writing the fix.
- **Verify polarity.** The test must FAIL on the unfixed code. If it passes,
  the test is testing a tautology, not the bug. Invert until it fails on
  broken code, then the fix flips it green.
- **Match the bug's surface area.** A test that calls a helper (`dispatchExit`)
  in isolation doesn't exercise the runtime-shutdown path that may still
  break the fix. The reproducer must touch the *system* the bug lives in.
- **Within a round**, land the test as a separate commit from the fix so the
  red->green transition is locally observable while iterating. **The round's
  compaction step (Step 5) squashes the pair into one commit** before the
  next review runs — neither this round's history nor the next reviewer
  should see the intermediate red state.

## Step 4 -- Verify

- Reproducer flips red -> green. Necessary, not sufficient.
- Every *adjacent contract* you identified during REFLECT also has a test.
  The whole class of bug, not just the named instance.
- Run the next adversarial review pass. If it surfaces a sibling of the same
  finding, the reflection wasn't deep enough -- go back to REFLECT, don't just
  patch the new finding.

## Step 5 -- COMPACT (final step of every round)

After verify is green, **before** triggering the next adversarial review,
compact this round into its canonical form. Compaction has three sub-steps,
all run on every round (not just the last one):

### 5a. Audit comments added this round

The REFLECT / Approaches Considered / Adjacent Contracts narrative belongs in
the **commit-message body**, not in source-file comments. Grep the files this
round touched:

```
grep -nE "round-[0-9]|Codex|finding #|REFLECT|\bF[1-9]\b" <changed-files>
```

Every match is debt. Comments must explain the *current* invariant; future
readers don't care which review round found the bug. Rewrite or delete.

Also check for:

- **Dead doc-blocks** for tests that were rewritten or deleted within this
  round (a 27-line "round-N reproducer" prologue with no test below it).
- **Verbose postscripts** explaining what wasn't tested or why a test was
  omitted. One line max, or delete.
- **DRY violations** when reflection identifies a primitive used at N call
  sites: document the primitive **once on its definition**; each call site
  gets a one-line reference, not a copy of the explanation.

### 5b. Squash this round's test+fix into one commit

`git rebase -i` with `pick test, fixup fix` (use `fixup` not `squash` to
silently drop the test commit's "test(...)" subject), then `reword` the
result to use the `fix(...)` subject. Or apply a
`git commit --amend -F <fix-message-file>` via `--exec` in the rebase TODO.

If this round's REFLECT identified that a *previous* round's fix was
wrong-headed (round-N+1 reverses round-N), this is the moment to fold the
previous round's commit into this round's commit — same `fixup` mechanism,
extra `fixup <prev-round-sha>` line in the TODO. Don't ship two commits where
the second undoes the first.

Sentinel: if this round's commit body says "round-N's approach was wrong
because…", that round-N commit should fold into this one.

### 5c. Verify tree-identity after the rewrite

Before and after the squash, snapshot the working-tree diff against the review
baseline and confirm they're identical:

```
git diff <upstream>..HEAD > /tmp/before.diff
# (do the rebase)
git diff <upstream>..HEAD > /tmp/after.diff
diff /tmp/before.diff /tmp/after.diff   # → empty
```

If the diffs differ, the rebase lost or duplicated something. Abort and redo.

## Anti-patterns

- **Reflection-as-apology.** "I should have been more careful" is not a root
  cause. "I never read `ExecStdout::next`" is.
- **Test polarity flip after seeing the green bar.** If the test was green on
  broken code, it's not a reproducer; it's confirmation bias.
- **One reproducer per finding, no class coverage.** If reflection identified
  6 payload types and only `CBoxHandle` has a test, the next review will find
  the other 5.
- **Treating the review as a checklist.** The review surfaces *symptoms*; the
  point of REFLECT is to find the design choice that produced them all.
- **Iteration narrative leaks into source comments.** "round-3 #1 race", "Codex
  finding #4", "REFLECT note: ..." in a doc-comment is debt — future readers
  treat it as load-bearing context for the current code. Narrative belongs in
  commit messages.
- **Embedding transient broken state in history.** Round-N landed wrong, round-N+1
  reverses it: `git log` shows one commit, not two. Fold N into N+1 during 5b.
- **Per-call-site copies of "see helper" comments.** Document the primitive once
  on its definition; each call site gets a one-liner reference.
- **Deferring compaction to end-of-loop.** Reviews 2..N are then framed against
  accumulating noise, fold-the-reversal becomes harder (more rounds in the way),
  and the end-of-loop chore is N× larger. Same total work, wrong distribution.

## Concretely, in this project's codebase

- Adversarial review tool: `/codex:adversarial-review` (foreground or `--background`)
- Reproducer commit pattern *within* a round: tests in commit N, fix in
  commit N+1. The local red->green transition is observable while iterating.
- COMPACT (Step 5) closes every round: squash N+N+1 into one `fix(...)` commit
  via `pick test, fixup fix, exec git commit --amend -F <msg>` in the rebase
  TODO. The next adversarial review runs against the compacted state.
- Squash-merge to PR is the team default; per-round compaction is upstream of
  that and ensures the PR's commit list reads as one fix per finding (not two)
  *and* the PR's review history is one finding per review (not N stacked).
