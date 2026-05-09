---
name: adversarial-iteration
description: >
  Use when iterating on a fix after an adversarial code review (Codex, human reviewer)
  surfaces design-level findings — not just typos or lint. Frames the review/fix loop
  as implement -> review -> ROOT-CAUSE REFLECT -> reproducer-first test -> fix -> verify,
  and provides a four-item cheap-checks list (timeline draw, upstream contract read,
  full lifecycle trace, variant enumeration) that catches the failure classes which
  recurrent reviews keep finding. Trigger when a review pass surfaces multiple
  findings on a single change, when sibling bugs of an "already-fixed" issue keep
  appearing, or when the user asks "why did I miss this?"
---

# Adversarial Iteration

A loop for working *with* adversarial review feedback instead of just patching to make findings go away.

## When to use

- A Codex/adversarial review surfaces 2+ findings on a fix you authored
- A reviewer flags issues that point at design gaps (not typos, lint, format)
- The same *class* of bug keeps reappearing across review rounds
- The user asks you to reflect on root causes

## When NOT to use

- Initial implementation (use the standard rules in `CLAUDE.md`)
- Single-line fixes where the cause is obvious from the diff
- Pure typo / formatter / dependency-bump work

## The loop

```
implement -> review -> REFLECT -> reproducer -> fix -> verify -> review
```

The unique step is **REFLECT**. Skipping it produces fixes that pass the named test
but seed the next finding in the same class.

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
- **Land tests in a separate commit** from the fix. The red->green transition
  in CI history is the documentation that the test actually catches the bug.

## Step 4 -- Verify

- Reproducer flips red -> green. Necessary, not sufficient.
- Every *adjacent contract* you identified during REFLECT also has a test.
  The whole class of bug, not just the named instance.
- Run the next adversarial review pass. If it surfaces a sibling of the same
  finding, the reflection wasn't deep enough -- go back to REFLECT, don't just
  patch the new finding.

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

## Concretely, in this project's codebase

- Adversarial review tool: `/codex:adversarial-review` (foreground or `--background`)
- Reproducer commit pattern: tests in commit N, fix in commit N+1, verify both pass
- Squash-merge to PR; the squash hides the red->green transition, but the
  branch history preserves it for audit
