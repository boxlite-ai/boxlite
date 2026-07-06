#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-verdict-check.sh (the Stop-stage verdict gate).
#
# The hook is delta-triggered + self-declared (loop-free):
#   - no dossier, no baseline / baseline == tree -> allow (no work, or no baseline hook)
#   - no dossier, tree CHANGED since turn start  -> block: audit the verdict (delta trigger)
#   - present, PASS/IN_PROGRESS, matching+fresh  -> allow (PASS is consumed)
#   - present, stale / mismatched / FAIL         -> block (hard) or nudge (soft)
# Each case builds a throwaway git repo, optionally writes a dossier, and runs the
# hook there (cwd + CLAUDE_PROJECT_DIR pointed at it), asserting allow vs block.
#
# Stop contract: allow = empty stdout (exit 0); block = stdout {"decision":"block"};
# soft nudge / IN_PROGRESS = {"continue":true,...} (non-empty, no block = allow).
#
# Run with:  bash .claude/hooks/preflight-verdict-check.test.sh
# Exits non-zero on any failure.
set -uo pipefail

# Hermetic baseline: neutralize any ambient VERDICT_GATE_HARD_BLOCK so the soft-mode
# cases below see it absent regardless of the caller's environment (a session or CI that
# exports it to hard-block would otherwise turn their nudges into blocks). Hard-mode
# cases set it explicitly in decide().
unset VERDICT_GATE_HARD_BLOCK

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-verdict-check.sh"
PAYLOAD='{"transcript_path":"/dev/null","hook_event_name":"Stop"}'

pass=0
fail=0

# Fresh git repo with one committed production file.
setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  mkdir -p "$d/src"
  printf 'pub fn base() {}\n' > "$d/src/lib.rs"
  # Mirror the real repo: the dossier and turn baseline are gitignored, so they
  # never enter the working-tree hash. Without this the hook's `git add -A` would
  # fold them into the hash — the dossier would never match what the auditor
  # computed, and writing the baseline would itself register as a turn delta.
  printf '.claude/.last-verdict.json\n.claude/.turn-baseline\n' > "$d/.gitignore"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  printf '%s' "$d"
}

# Same content-addressed tree hash the hook computes (keep in sync).
tree_hash_of() {
  local repo="$1" idx; idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo" add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo" write-tree 2>/dev/null
  rm -f "$idx"
}

# Record the turn-start baseline the way turn-baseline.sh does (current tree hash).
write_baseline() {
  local repo="$1"
  mkdir -p "$repo/.claude"
  tree_hash_of "$repo" > "$repo/.claude/.turn-baseline"
}

# Write a dossier; tree_hash defaults to the repo's current working-tree hash.
write_verdict() {
  local repo="$1" verdict="$2" findings="$3" tree="${4:-$(tree_hash_of "$1")}"
  local br hd; br="$(git -C "$repo" branch --show-current)"; hd="$(git -C "$repo" rev-parse HEAD)"
  mkdir -p "$repo/.claude"
  jq -nc --arg b "$br" --arg h "$hd" --arg t "$tree" --arg v "$verdict" --argjson f "$findings" \
    '{branch:$b, head:$h, tree_hash:$t, verdict:$v, proof:[], findings:$f}' \
    > "$repo/.claude/.last-verdict.json"
}

# Run the hook inside repo and classify the decision.
decide() {
  local repo="$1" out d
  # Decision-logic cases run in HARD mode so a block condition is observable as
  # decision:block. Soft mode (the default) is covered in its own section below.
  out="$(printf '%s' "$PAYLOAD" | ( cd "$repo" && CLAUDE_PROJECT_DIR="$repo" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
  if [[ -z "$out" ]]; then
    printf 'allow'
  else
    d="$(printf '%s' "$out" | jq -r '.decision // "allow"' 2>/dev/null || echo parse_error)"
    [[ "$d" == "block" ]] && printf 'block' || printf 'allow'
  fi
}

check() {  # desc  repo  expect
  local desc="$1" repo="$2" expect="$3" got
  got="$(decide "$repo")"
  if [[ "$got" == "$expect" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s expected=%s)\n' "$desc" "$got" "$expect"
  fi
}

# Assert the dossier file was consumed (removed) by the hook's allow path.
check_consumed() {  # desc  repo
  local desc="$1" repo="$2"
  if [[ ! -e "$repo/.claude/.last-verdict.json" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (dossier still present after allow)\n' "$desc"
  fi
}

echo "## No dossier, no baseline → allow (fallback: harness without the baseline hook)"
R="$(setup)";                                    check "clean tree, no baseline → allow"  "$R" "allow"; rm -rf "$R"
R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; check "prod change, no baseline → allow" "$R" "allow"; rm -rf "$R"

echo
echo "## No dossier, baseline present → the turn delta decides"
R="$(setup)"; write_baseline "$R"
check "no delta since turn start → allow"                "$R" "allow"; rm -rf "$R"

# The delta trigger: work happened this turn and no verdict was audited → block.
R="$(setup)"; write_baseline "$R"; printf 'fix\n' >> "$R/src/lib.rs"
check "tracked file changed this turn → block"           "$R" "block"; rm -rf "$R"

R="$(setup)"; write_baseline "$R"; printf 'x' > "$R/src/new.rs"
check "untracked file added this turn → block"           "$R" "block"; rm -rf "$R"

# Dirty-before-turn is NOT a delta: the baseline captured the dirty state at turn
# start, so a conversational turn over a dirty tree still ends freely.
R="$(setup)"; printf 'wip\n' >> "$R/src/lib.rs"; write_baseline "$R"
check "tree dirty before turn, unchanged during → allow" "$R" "allow"; rm -rf "$R"

# Corrupt baseline fails open to the self-declared fallback (never trap on bad state).
R="$(setup)"; mkdir -p "$R/.claude"; printf 'not a hash' > "$R/.claude/.turn-baseline"; printf 'fix\n' >> "$R/src/lib.rs"
check "corrupt baseline → allow (fail-open)"             "$R" "allow"; rm -rf "$R"

R="$(setup)"; write_baseline "$R"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]"
check "delta + matching PASS dossier → allow"            "$R" "allow"
check_consumed "delta-path PASS dossier consumed"        "$R"; rm -rf "$R"

echo
echo "## Present dossier → validate verdict"
R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]"
check "code change + matching PASS → allow"      "$R" "allow"
check_consumed "PASS dossier consumed on allow"  "$R"
check "after consume (no dossier) → allow"       "$R" "allow"; rm -rf "$R"

# A verdict with NO file change (ops / investigation) still validates against the
# clean-tree hash — this is the whole point of covering non-code verdicts.
R="$(setup)"; write_verdict "$R" "PASS" "[]"
check "no-file-change verdict + PASS → allow"    "$R" "allow"; rm -rf "$R"

R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "FAIL" '["Test: no reproducer"]'
check "FAIL verdict → block"                     "$R" "block"; rm -rf "$R"

R="$(setup)"; write_verdict "$R" "FAIL" '["finding cites no command output"]'
check "no-file-change verdict + FAIL → block"    "$R" "block"; rm -rf "$R"

R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "IN_PROGRESS" '["mid-task"]'
check "IN_PROGRESS → allow"                      "$R" "allow"; rm -rf "$R"

echo
echo "## Present dossier → binding (branch / head / tree_hash / freshness)"
R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
check "tree_hash mismatch → block"               "$R" "block"; rm -rf "$R"

R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]"
jq '.head="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"' "$R/.claude/.last-verdict.json" > "$R/.claude/x" \
  && mv "$R/.claude/x" "$R/.claude/.last-verdict.json"
check "HEAD mismatch → block"                    "$R" "block"; rm -rf "$R"

R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]"
touch -t 202001010000 "$R/.claude/.last-verdict.json"
check "stale mtime (>max_age) → block"           "$R" "block"; rm -rf "$R"

R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "PASS" "[]"
# Change the tree AFTER auditing → dossier no longer matches.
printf 'more\n' >> "$R/src/lib.rs"
check "tree changed after audit → block"         "$R" "block"; rm -rf "$R"

echo
echo "## Soft mode (VERDICT_GATE_HARD_BLOCK unset/0): block conditions become nudges"
R="$(setup)"; printf 'fix\n' >> "$R/src/lib.rs"; write_verdict "$R" "FAIL" '["no reproducer"]'
soft_out="$(printf '%s' "$PAYLOAD" | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$soft_out" | jq -e '(.decision // "") != "block" and .continue == true and (.systemMessage | type) == "string"' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "FAIL dossier → nudge (continue:true + systemMessage), not block"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (out=%s)\n' "soft-mode nudge" "$soft_out"
fi
rm -rf "$R"

R="$(setup)"; write_baseline "$R"; printf 'fix\n' >> "$R/src/lib.rs"
soft_delta="$(printf '%s' "$PAYLOAD" | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$soft_delta" | jq -e '(.decision // "") != "block" and .continue == true and (.systemMessage | type) == "string"' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "delta without dossier → nudge in soft mode, not block"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (out=%s)\n' "soft-mode delta nudge" "$soft_delta"
fi
rm -rf "$R"

R="$(setup)"  # no dossier, no baseline → allow (empty output) in BOTH soft and hard — the fallback guarantee
soft_nodossier="$(printf '%s' "$PAYLOAD" | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
hard_nodossier="$(printf '%s' "$PAYLOAD" | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
if [[ -z "$soft_nodossier" && -z "$hard_nodossier" ]]; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "no dossier → allow (empty output), never blocks/nudges in soft OR hard"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (soft=%s hard=%s)\n' "no-dossier allow" "$soft_nodossier" "$hard_nodossier"
fi
rm -rf "$R"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
