#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-commit-push.sh
#
# Covers the two areas CLAUDE.md flags for required tests on this change:
#   1. Command matcher (parsing + branching): direct invocation vs. chain
#      segments vs. literal-string mentions inside arguments.
#   2. Gate logic (branching + boundary validation): missing / mismatched /
#      stale / FAIL / consumed audit-file paths.
#
# Run with:  bash .claude/hooks/preflight-commit-push.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-commit-push.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Redirect the hook's audit-file lookup into TMP so tests don't touch the real
# .claude/.last-audit.json. The hook still uses git from the real repo for
# branch/HEAD detection — that's fine, we read the same values for assertions.
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

write_audit() {
  local verdict="$1" findings_json="$2" kind="$3"
  jq -nc --arg b "$BRANCH" --arg h "$HEAD_SHA" \
        --arg v "$verdict" --arg k "$kind" \
        --argjson f "$findings_json" \
        '{branch:$b, head:$h, command_kind:$k, verdict:$v, findings:$f}' \
        > "$TMP/.claude/.last-audit.json"
}

GC='git commit'
GP='git push'

echo "## Matcher: should pass through (not a git commit/push invocation)"
rm -f "$TMP/.claude/.last-audit.json"
run "ls"                                "ls"                          "passthrough"
run "echo with literal mention"         "echo \"$GC\""                "passthrough"
run "grep with literal mention"         "grep \"$GC\" file"           "passthrough"
run "git status (different verb)"       "git status"                  "passthrough"
run "git log (different verb)"          "git log --oneline -5"        "passthrough"

echo
echo "## Matcher: should gate (real git commit/push invocation)"
run "direct commit"                     "$GC -m wip"                  "deny"
run "direct push"                       "$GP origin main"             "deny"
run "chained with &&"                   "cd x && $GC -m wip"          "deny"
run "chained with ||"                   "true || $GC -m foo"          "deny"
run "chained with ;"                    "echo done; $GC"              "deny"
run "env var prefix"                    "FOO=bar $GC -m x"            "deny"
run "command substitution"              "out=\$($GC -m foo)"          "deny"
run "push after &&"                     "cat x && $GP origin main"    "deny"

echo
echo "## Gate logic: audit file states"
write_audit "PASS" "[]" "commit"
run "PASS verdict matches → allow"      "$GC -m foo"                  "passthrough"
run "verdict consumed on allow"         "$GC -m foo"                  "deny"

write_audit "FAIL" '["Test: missing"]' "commit"
run "FAIL verdict → deny"               "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
# Mutate head field to simulate a stale-by-HEAD audit
jq --arg h "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" '.head=$h' \
   "$TMP/.claude/.last-audit.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.last-audit.json"
run "HEAD mismatch → deny"              "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
touch -t 202001010000 "$TMP/.claude/.last-audit.json"
run "stale mtime (>max_age) → deny"     "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
run "kind mismatch (commit vs push)"    "$GP origin main"             "deny"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
