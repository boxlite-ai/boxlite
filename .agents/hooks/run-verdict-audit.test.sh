#!/usr/bin/env bash
# Tests for .agents/hooks/run-verdict-audit.sh (the harness-neutral audit runner).
#
# Contract:
#   - resolves VERDICT_AUDITOR_CMD first (stdin = audit prompt), else claude CLI
#   - succeeds (exit 0) only when a FRESH, well-formed dossier lands
#   - exit 1 when the runner ran but produced no dossier
#   - exit 2 when no runner is available / no transcript arg
#   - a pre-existing dossier does not count as success (freshness check)
#
# Run with:  bash .agents/hooks/run-verdict-audit.test.sh
set -uo pipefail

# Resolve from THIS script's location, not the caller's cwd. `git rev-parse
# --show-toplevel` returns whichever checkout the shell sits in, so running this
# suite from another worktree silently tests THAT checkout's copy instead of the
# one shipped beside these tests, and a two-side check reports a false pass.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO_ROOT/.agents/hooks/run-verdict-audit.sh"

pass=0
fail=0

setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  printf 'x\n' > "$d/f"
  printf '.agents/state/last-verdict.json\n' > "$d/.gitignore"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  mkdir -p "$d/.agents/state"
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
DOSSIER_STUB='cat >/dev/null; mkdir -p "$CLAUDE_PROJECT_DIR/.agents/state"; printf "{\"branch\":\"main\",\"head\":\"h\",\"tree_hash\":\"t\",\"verdict\":\"PASS\",\"proof\":[],\"findings\":[]}" > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"'

echo "## Runner resolution and success criteria"
R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD="$DOSSIER_STUB" bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes dossier → exit 0"                      "$?" 0
dossier_state="missing"; [[ -s "$R/.agents/state/last-verdict.json" ]] && dossier_state="present"
check_eq "dossier present after run"                         "$dossier_state" "present"
rm -rf "$R"

R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD='cat >/dev/null' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes nothing → exit 1"                      "$?" 1
rm -rf "$R"

# A leftover dossier from an earlier audit must NOT satisfy the freshness check.
R="$(setup)"
printf '{"branch":"main","head":"h","tree_hash":"t","verdict":"PASS","proof":[],"findings":[]}' > "$R/.agents/state/last-verdict.json"
touch -t 202001010000 "$R/.agents/state/last-verdict.json"
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

# A no-runner invocation exits 2 WITHOUT auditing, so it must not destroy a dossier
# on its way out. The freshness removal therefore sits inside each runner branch.
D="$(mktemp -d)"; mkdir -p "$D/.agents/state"
printf '{"verdict":"PASS","branch":"b","tree_hash":"t"}' > "$D/.agents/state/last-verdict.json"
printf 'x' > "$D/t.jsonl"
( cd "$D" && env -u VERDICT_AUDITOR_CMD CLAUDE_PROJECT_DIR="$D" PATH=/usr/bin:/bin \
    bash "$RUNNER" "$D/t.jsonl" >/dev/null 2>&1 )
if [[ -f "$D/.agents/state/last-verdict.json" ]]; then
  pass=$((pass + 1)); printf '  PASS  a no-runner invocation leaves an existing dossier intact\n'
else
  fail=$((fail + 1)); printf '  FAIL  a no-runner invocation leaves an existing dossier intact\n'
fi
rm -rf "$D"

# Freshness is proven by existence, so an auditor that rewrites within one second is
# still accepted — mtime comparison rejected it, and a fast stub hits that window.
D="$(mktemp -d)"; mkdir -p "$D/.agents/state"
printf '{"verdict":"STALE","branch":"b","tree_hash":"t"}' > "$D/.agents/state/last-verdict.json"
printf 'x' > "$D/t.jsonl"
( cd "$D" && CLAUDE_PROJECT_DIR="$D" \
    VERDICT_AUDITOR_CMD='cat >/dev/null; printf "{\"verdict\":\"PASS\",\"branch\":\"b\",\"tree_hash\":\"t\"}" > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"' \
    bash "$RUNNER" "$D/t.jsonl" >/dev/null 2>&1 )
rc=$?
got="$(jq -r '.verdict' "$D/.agents/state/last-verdict.json" 2>/dev/null)"
if [[ "$rc" == "0" && "$got" == "PASS" ]]; then
  pass=$((pass + 1)); printf '  PASS  a same-second rewrite is accepted as fresh\n'
else
  fail=$((fail + 1)); printf '  FAIL  a same-second rewrite is accepted as fresh  (rc=%s verdict=%s)\n' "$rc" "$got"
fi
rm -rf "$D"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
