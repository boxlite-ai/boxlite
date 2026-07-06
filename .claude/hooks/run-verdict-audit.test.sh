#!/usr/bin/env bash
# Tests for .claude/hooks/run-verdict-audit.sh (the harness-neutral audit runner).
#
# Contract:
#   - resolves VERDICT_AUDITOR_CMD first (stdin = audit prompt), else claude CLI
#   - succeeds (exit 0) only when a FRESH, well-formed dossier lands
#   - exit 1 when the runner ran but produced no dossier
#   - exit 2 when no runner is available / no transcript arg
#   - a pre-existing dossier does not count as success (freshness check)
#
# Run with:  bash .claude/hooks/run-verdict-audit.test.sh
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
RUNNER="$REPO_ROOT/.claude/hooks/run-verdict-audit.sh"

pass=0
fail=0

setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  printf 'x\n' > "$d/f"
  printf '.claude/.last-verdict.json\n' > "$d/.gitignore"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  mkdir -p "$d/.claude"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"tests pass"}]}}\n' > "$d/transcript.jsonl"
  printf '%s' "$d"
}

check_eq() {  # desc  got  want
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s want=%s)\n' "$desc" "$got" "$want"
  fi
}

# Stub that writes a plausible dossier (what a real auditor leaves behind).
DOSSIER_STUB='cat >/dev/null; mkdir -p "$CLAUDE_PROJECT_DIR/.claude"; printf "{\"branch\":\"main\",\"head\":\"h\",\"tree_hash\":\"t\",\"verdict\":\"PASS\",\"proof\":[],\"findings\":[]}" > "$CLAUDE_PROJECT_DIR/.claude/.last-verdict.json"'

echo "## Runner resolution and success criteria"
R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD="$DOSSIER_STUB" bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes dossier → exit 0"                      "$?" 0
dossier_state="missing"; [[ -s "$R/.claude/.last-verdict.json" ]] && dossier_state="present"
check_eq "dossier present after run"                         "$dossier_state" "present"
rm -rf "$R"

R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD='cat >/dev/null' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes nothing → exit 1"                      "$?" 1
rm -rf "$R"

# A leftover dossier from an earlier audit must NOT satisfy the freshness check.
R="$(setup)"
printf '{"branch":"main","head":"h","tree_hash":"t","verdict":"PASS","proof":[],"findings":[]}' > "$R/.claude/.last-verdict.json"
touch -t 202001010000 "$R/.claude/.last-verdict.json"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD='cat >/dev/null' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stale pre-existing dossier does not count → exit 1" "$?" 1
rm -rf "$R"

echo
echo "## Failure modes"
R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$RUNNER" >/dev/null 2>&1 )
check_eq "missing transcript arg → exit 2"                   "$?" 2
rm -rf "$R"

R="$(setup)"
out="$( cd "$R" && CLAUDE_PROJECT_DIR="$R" PATH=/usr/bin:/bin VERDICT_AUDITOR_CMD='' bash "$RUNNER" "$R/transcript.jsonl" 2>&1 )"
check_eq "no runner available → exit 2"                      "$?" 2
names_seam="no"; printf '%s' "$out" | grep -q VERDICT_AUDITOR_CMD && names_seam="yes"
check_eq "exit-2 message names VERDICT_AUDITOR_CMD"          "$names_seam" "yes"
rm -rf "$R"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
