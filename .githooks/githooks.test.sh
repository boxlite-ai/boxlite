#!/usr/bin/env bash
# Tests for the agent-agnostic git-hook gate layer (.githooks/pre-commit,
# .githooks/pre-push) and the PreToolUse delegation guard in
# .claude/hooks/preflight-commit-push.sh.
#
# Contract under test:
#   - agent marker present (CLAUDECODE / CODEX_SANDBOX / AGENT_GATED) + no audit -> commit/push rejected
#   - agent marker + fresh matching PASS audit                              -> allowed, audit consumed
#   - no agent marker (human)                                              -> allowed, ungated
#   - framework hook in .git/hooks is chained after the gate (prek keeps running)
#   - PreToolUse script defers when core.hooksPath -> .githooks (single consumer),
#     EXCEPT when called BY the git-level gate (GITHOOK_DELEGATED)
#
# Run with:  bash .githooks/githooks.test.sh
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

pass=0
fail=0

check_eq() {  # desc  got  want
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s want=%s)\n' "$desc" "$got" "$want"
  fi
}

# Fixture repo with the real gate scripts copied in and hooksPath pointed at
# its own .githooks (absolute, so hook execution is location-independent).
setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  mkdir -p "$d/.githooks" "$d/.claude/hooks"
  cp "$REPO_ROOT/.githooks/pre-commit" "$REPO_ROOT/.githooks/pre-push" "$d/.githooks/"
  cp "$REPO_ROOT/.claude/hooks/preflight-commit-push.sh" "$d/.claude/hooks/"
  printf 'x\n' > "$d/f"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  git -C "$d" config core.hooksPath "$d/.githooks"
  printf '%s' "$d"
}

# Fresh PASS audit bound to the fixture's current state.
write_audit() {  # repo kind
  local repo="$1" kind="$2" br hd
  br="$(git -C "$repo" branch --show-current)"; hd="$(git -C "$repo" rev-parse HEAD)"
  jq -nc --arg b "$br" --arg h "$hd" --arg k "$kind" \
    '{branch:$b, head:$h, command_kind:$k, verdict:"PASS", findings:[]}' \
    > "$repo/.claude/.last-audit.json"
}

# Run `git commit` in the fixture as agent or human; echo the exit code.
# env -i gives a hermetic environment: the ambient session's own harness markers
# (CLAUDECODE, CLAUDE_PROJECT_DIR, plugin CODEX_COMPANION_*) must not leak into
# the fixture's gate decision.
try_commit() {  # repo  agent|human
  local repo="$1" who="$2"
  printf 'y\n' >> "$repo/f"; git -C "$repo" add -A
  if [[ "$who" == "agent" ]]; then
    ( cd "$repo" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git commit -qm change >/dev/null 2>"$repo/err.txt" )
  else
    ( cd "$repo" && env -i PATH="$PATH" HOME="$HOME" git commit -qm change >/dev/null 2>"$repo/err.txt" )
  fi
  echo $?
}

echo "## pre-commit: agent gated, human exempt"
R="$(setup)"
check_eq "agent + no audit → commit rejected"       "$(try_commit "$R" agent)" 1
grep -q 'commit-push-auditor' "$R/err.txt" && names=yes || names=no
check_eq "rejection names commit-push-auditor"      "$names" "yes"
rm -rf "$R"

R="$(setup)"; write_audit "$R" commit
check_eq "agent + PASS audit → commit allowed"      "$(try_commit "$R" agent)" 0
[[ -e "$R/.claude/.last-audit.json" ]] && consumed=no || consumed=yes
check_eq "audit consumed by the git-level gate"     "$consumed" "yes"
rm -rf "$R"

R="$(setup)"
check_eq "human (no marker) → commit allowed"       "$(try_commit "$R" human)" 0
rm -rf "$R"

echo
echo "## chaining: the framework hook in .git/hooks still runs"
R="$(setup)"
# --git-common-dir: --git-path hooks would resolve through core.hooksPath and
# point back at the adapter itself (the exact recursion the adapters guard).
# Absolutize from inside the fixture — the raw output is cwd-relative (".git").
hooks_dir="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$hooks_dir"
printf '#!/bin/sh\ntouch "%s/chained.ran"\n' "$R" > "$hooks_dir/pre-commit"
chmod +x "$hooks_dir/pre-commit"
try_commit "$R" human >/dev/null
[[ -e "$R/chained.ran" ]] && chained=yes || chained=no
check_eq "chained .git/hooks/pre-commit executed"   "$chained" "yes"
rm -rf "$R"

echo
echo "## pre-push: same contract at the push boundary"
R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin HEAD >/dev/null 2>"$R/err.txt" )
check_eq "agent + no audit → push rejected"         "$?" 1
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
write_audit "$R" push
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin HEAD >/dev/null 2>"$R/err.txt" )
check_eq "agent + PASS audit → push allowed"        "$?" 0
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin HEAD >/dev/null 2>"$R/err.txt" )
check_eq "human → push allowed, ungated"            "$?" 0
rm -rf "$R" "$B"

echo
echo "## delegation guard: exactly one consumer of the audit artifact"
# With hooksPath installed, the PreToolUse layer must step aside (exit 0,
# no deny) even when a commit would otherwise be rejected...
R="$(setup)"
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
check_eq "PreToolUse defers when .githooks installed"  "${out:-EMPTY}" "EMPTY"
# ...but the call coming FROM the git-level gate must still be judged.
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" GITHOOK_DELEGATED=1 bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "GITHOOK_DELEGATED call still judged (deny)"  "$denied" "yes"
rm -rf "$R"

# hooksPath configured but the delegate hook ABSENT (old ref, broken install):
# git silently skips missing hooks, so deferring here would stand BOTH layers
# down — the PreToolUse layer must gate itself (fail closed).
R="$(setup)"; rm "$R/.githooks/pre-commit"
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "hooksPath set, delegate missing → fail closed (deny)" "$denied" "yes"
rm -rf "$R"

# Without hooksPath, the PreToolUse layer gates as before (no regression).
R="$(setup)"; git -C "$R" config --unset core.hooksPath
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "no hooksPath → PreToolUse still gates"       "$denied" "yes"
rm -rf "$R"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
