#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-pr-review.sh
#
# Covers:
#   1. Command matcher: gh pr create / edit / ready vs. unrelated bash,
#      chained invocations, draft exclusion.
#   2. Gate logic: missing / mismatched / stale / malformed-message /
#      consumed marker paths.
#
# Run with:  bash .claude/hooks/preflight-pr-review.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-pr-review.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export CLAUDE_PROJECT_DIR="$TMP"
mkdir -p "$TMP/.claude"

BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

pass=0
fail=0

run() {
  local desc="$1" cmd="$2" expect="$3" out decision
  out=$(printf '%s' "$cmd" | jq -Rs '{tool_input:{command:.}}' | "$HOOK")
  if [[ -z "$out" ]]; then
    decision="passthrough"
  else
    decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null || echo "parse_error")
  fi
  if [[ "$decision" == "$expect" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s  (got=%s expected=%s)\n' "$desc" "$decision" "$expect"
  fi
}

write_marker() {
  local message="$1"
  jq -nc --arg b "$BRANCH" --arg h "$HEAD_SHA" --arg m "$message" \
        '{branch:$b, head:$h, message:$m}' \
        > "$TMP/.claude/.pr-reviewed.json"
}

echo "## Matcher: should pass through (not a gated gh pr invocation)"
rm -f "$TMP/.claude/.pr-reviewed.json"
run "ls"                                "ls"                                "passthrough"
run "gh pr list (different subcmd)"     "gh pr list"                        "passthrough"
run "gh pr view (different subcmd)"     "gh pr view 123"                    "passthrough"
run "gh issue create (different verb)"  "gh issue create -t foo"            "passthrough"
run "echo literal mention"              "echo 'gh pr create'"               "passthrough"
run "git push (other hook's domain)"    "git push origin main"              "passthrough"
run "heredoc body mentions trigger"     $'git commit -m "$(cat <<\'EOF\'\nbody mentions `gh pr create`\nEOF\n)"' "passthrough"
run "multiline w/ backtick trigger"     $'git commit -m "fix bug"\n# `gh pr create`' "passthrough"

echo
echo "## Matcher: draft exclusion (only on create)"
run "gh pr create --draft"              "gh pr create --draft -t wip"       "passthrough"
run "gh pr create -d short flag"        "gh pr create -d -t wip"            "passthrough"

echo
echo "## Matcher: should gate"
run "gh pr create direct"               "gh pr create -t foo"               "deny"
run "gh pr edit direct"                 "gh pr edit 42 --body foo"          "deny"
run "gh pr ready direct"                "gh pr ready 42"                    "deny"
run "chained with &&"                   "cd x && gh pr create -t foo"       "deny"
run "chained with ;"                    "echo done; gh pr create -t foo"    "deny"
run "command substitution"              "out=\$(gh pr create -t foo)"       "deny"
run "env var prefix"                    "FOO=bar gh pr create -t foo"       "deny"

echo
echo "## Gate logic: marker file states"
write_marker "reviewed: refactor auth middleware"
run "valid marker → allow"              "gh pr create -t foo"               "passthrough"
run "marker consumed on allow"          "gh pr create -t foo"               "deny"

write_marker "reviewed: edit body fix"
run "valid marker for edit → allow"     "gh pr edit 42"                     "passthrough"

write_marker "yes"
run "malformed message → deny"          "gh pr create -t foo"               "deny"

write_marker ""
run "empty message → deny"              "gh pr create -t foo"               "deny"

write_marker "reviewed: stale"
jq --arg h "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" '.head=$h' \
   "$TMP/.claude/.pr-reviewed.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.pr-reviewed.json"
run "HEAD mismatch → deny"              "gh pr create -t foo"               "deny"

write_marker "reviewed: branch test"
jq --arg b "some-other-branch" '.branch=$b' \
   "$TMP/.claude/.pr-reviewed.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.pr-reviewed.json"
run "branch mismatch → deny"            "gh pr create -t foo"               "deny"

write_marker "reviewed: old"
touch -t 202001010000 "$TMP/.claude/.pr-reviewed.json"
run "stale mtime (>max_age) → deny"     "gh pr create -t foo"               "deny"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
