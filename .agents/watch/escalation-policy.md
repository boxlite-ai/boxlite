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

<!-- ─────────────────────────────────────────────────────────────────────────
TODO(user, learning-mode): this list is the actual contract — it decides when an
agent may edit your code unattended. Same convention as the ack-instruction
block in .claude/hooks/preflight-pr-review.sh:116.

Below is a DRAFT default. Replace it with your rule. Things worth deciding:

  • Infra/flaky failures (cache miss, network, runner OOM, timeout) — is
    `gh run rerun --failed` allowed automatically, or is any rerun your call?
  • A fix that would touch files outside the PR's own diff — scope creep. Ask,
    or allow when the fix is obviously local to the failure?
  • Review comments from `boxlite-agent` / `coderabbitai` — auto-address the
    mechanical ones (typos, missing null-check), ask on design calls? Or never
    auto-address review feedback at all?
  • `e2e-local` / `e2e-cloud` — label-gated `pull_request_target` workflows,
    expensive and slow. Auto-retry, or always ask?
  • Anything touching .githooks/, .claude/, or .agents/ — the gate machinery
    itself. Auto-fix, or always ask?

Keep it to conditions, not prose. Each line should be checkable.
──────────────────────────────────────────────────────────────────────────── -->

Draft default — escalate rather than act when **any** of these hold:

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
