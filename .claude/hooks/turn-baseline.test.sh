#!/usr/bin/env bash
# Tests for .claude/hooks/turn-baseline.sh (the UserPromptSubmit turn-start snapshot).
#
# Contract:
#   - writes the current working-tree hash to .claude/.turn-baseline (same
#     content-addressed hash the Stop gate recomputes)
#   - dirty tree  -> one-line audit reminder on stdout (UserPromptSubmit stdout
#     is injected into the model's context)
#   - clean tree  -> no output
#   - ALWAYS exits 0, even outside a git repo (a non-zero UserPromptSubmit hook
#     blocks the user's prompt — this hook must never do that)
#
# Run with:  bash .claude/hooks/turn-baseline.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/turn-baseline.sh"
PAYLOAD='{"prompt":"hello","hook_event_name":"UserPromptSubmit"}'

pass=0
fail=0

setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  mkdir -p "$d/src"
  printf 'pub fn base() {}\n' > "$d/src/lib.rs"
  printf '.claude/.last-verdict.json\n.claude/.turn-baseline\n' > "$d/.gitignore"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  printf '%s' "$d"
}

# Same content-addressed tree hash the hooks compute (keep in sync).
tree_hash_of() {
  local repo="$1" idx; idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo" add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo" write-tree 2>/dev/null
  rm -f "$idx"
}

# stdout of the hook; exit status propagates so callers use: out="$(run_hook R)"; RC=$?
run_hook() {
  local repo="$1"
  printf '%s' "$PAYLOAD" | ( cd "$repo" && CLAUDE_PROJECT_DIR="$repo" bash "$HOOK" ) 2>/dev/null
}

check() {  # desc  cond(0=ok)
  local desc="$1" cond="$2"
  if [[ "$cond" == "0" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s\n' "$desc"
  fi
}

echo "## Baseline recording"
R="$(setup)"
out="$(run_hook "$R")"; RC=$?
expected="$(tree_hash_of "$R")"
recorded="$(cat "$R/.claude/.turn-baseline" 2>/dev/null || echo MISSING)"
check "exit 0 on clean tree"                        "$([[ $RC -eq 0 ]]; echo $?)"
check "baseline file holds current tree hash"       "$([[ "$recorded" == "$expected" ]]; echo $?)"
check "clean tree → no stdout (no reminder)"        "$([[ -z "$out" ]]; echo $?)"
rm -rf "$R"

R="$(setup)"
run_hook "$R" >/dev/null
first="$(cat "$R/.claude/.turn-baseline")"
printf 'edit\n' >> "$R/src/lib.rs"
run_hook "$R" >/dev/null
second="$(cat "$R/.claude/.turn-baseline")"
check "re-run after edit overwrites baseline"       "$([[ "$first" != "$second" && "$second" == "$(tree_hash_of "$R")" ]]; echo $?)"
rm -rf "$R"

echo
echo "## Dirty-tree reminder"
R="$(setup)"; printf 'wip\n' >> "$R/src/lib.rs"
out="$(run_hook "$R")"; RC=$?
check "exit 0 on dirty tree"                        "$([[ $RC -eq 0 ]]; echo $?)"
check "dirty tree → one-line reminder on stdout"    "$([[ -n "$out" && "$(printf '%s' "$out" | wc -l | tr -d ' ')" -le 1 ]]; echo $?)"
check "reminder names the verdict-auditor"          "$(printf '%s' "$out" | grep -q 'verdict-auditor'; echo $?)"
rm -rf "$R"

echo
echo "## Never blocks the prompt"
D="$(mktemp -d)"   # plain dir, not a git repo
out="$(printf '%s' "$PAYLOAD" | ( cd "$D" && CLAUDE_PROJECT_DIR="$D" bash "$HOOK" ) 2>/dev/null)"
RC=$?
check "non-repo → exit 0, silent"                   "$([[ $RC -eq 0 && -z "$out" ]]; echo $?)"
check "non-repo → no baseline written"              "$([[ ! -e "$D/.claude/.turn-baseline" ]]; echo $?)"
rm -rf "$D"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
