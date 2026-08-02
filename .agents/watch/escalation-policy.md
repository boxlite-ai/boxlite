# CI auto-fix escalation policy

Read by any agent consuming a `pr-watch` event stream. Plain Markdown, not a
Claude-specific format, so Codex and opencode follow the same rule.

The watcher only reports. This file decides what an agent may do about a red
check or a review comment **without asking a human first**.

## Hard limits

- **At most 2 auto-fix attempts per PR head.** After the second push fails to
  turn CI green, stop and report. A third attempt means the diagnosis is wrong,
  and each one costs a full CI run.
- **Never** auto-fix by weakening a test, loosening an assertion, adding a skip,
  or widening an allow-list to make a check pass. Fix the code under test.
  (CLAUDE.md → Test: "Never weaken a test to force it green".)
- **Never** auto-push to `main`.
- Always read the actual failure (`gh run view <run-id> --log-failed`) before
  editing. The check name is not the diagnosis.
- Reproduce locally with the smallest relevant `make` target before pushing a
  fix. A fix that was never run locally is a guess.

## Stop and ask a human

Notification is separate from action: every comment and review is notified,
bots included. This section is only about what may be CHANGED without asking.

Each line is a condition, checkable from the event and the diff.

Escalate rather than act when **any** of these hold:

1. The failure has no code signal: runner OOM, network error, cache miss,
   timeout, or a job that never started. Report it and name the run; do not
   edit code and do not rerun without being asked.
2. The fix would touch a file not already in this PR's diff
   (`git diff --name-only origin/main...HEAD`).
3. The failing job is `e2e-local` or `e2e-cloud`.
4. The change would touch `.githooks/`, `.claude/`, `.codex/`, or `.agents/` —
   the gate and watch machinery itself.
5. A review comment asks for a design change, a rename in a shared spec, or
   anything whose "right answer" depends on product intent.
6. Two auto-fix attempts have already been made on this PR head.
7. The same check fails again with a *different* error after a fix — the
   original diagnosis was wrong.

Otherwise: fix it, push, and report what changed and why.

## Review comments

Review findings are triaged before they are fixed, because a reviewer that sees
a renamed file reports the whole file as new:

1. Establish which findings the change actually introduced. Compare the file
   against the merge base with paths normalised; a file that differs by zero
   lines carries no finding of yours.
2. Fix the ones you introduced, in the same PR.
3. Leave the pre-existing ones. Say so in the PR rather than bundling them —
   a rename PR carrying unrelated bug fixes stops being reviewable.
4. Never resolve a finding you did not fix without saying why. Resolved-and-
   unfixed is worse than open, because it removes the reviewer's signal.

A bot finding is a claim, not a verdict. Reproduce it before fixing it, and
before dismissing it — on this repo a reviewer has been right where a prior
audit had waved the same line through.
