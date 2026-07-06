#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-verdict-check.sh (the Stop-stage verdict gate).
#
# The hook is DETECTION-TRIGGERED, with finding-driven loops only:
#   - no dossier + final message asserts a verdict ("root cause is X",
#     "tests pass", "prod looks healthy", "done")      -> block: audit it
#   - no dossier + chat / question / no transcript     -> allow
#   - present PASS/IN_PROGRESS, fresh + matching       -> allow (consumed)
#   - present FAIL, fresh + matching                   -> block with findings
#     (the ONE legitimate loop: persists until re-audited clean)
#   - present but stale / mismatched binding           -> DISCARD, re-detect
#     (bookkeeping never blocks — that was the meaningless-loop class)
# Each case builds a throwaway git repo with an optional fake transcript and
# dossier, runs the hook there (cwd + CLAUDE_PROJECT_DIR pointed at it), and
# asserts allow vs block.
#
# Stop contract: allow = empty stdout (exit 0); block = stdout {"decision":"block"};
# soft nudge / IN_PROGRESS = {"continue":true,...} (non-empty, no block = allow).
#
# Run with:  bash .claude/hooks/preflight-verdict-check.test.sh
# Exits non-zero on any failure.
set -uo pipefail

# Hermetic baseline: neutralize any ambient VERDICT_GATE_HARD_BLOCK so the soft-mode
# cases below see it absent regardless of the caller's environment. Hard-mode cases
# set it explicitly in decide().
unset VERDICT_GATE_HARD_BLOCK

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-verdict-check.sh"

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
  # Mirror the real repo: the dossier is gitignored, so it never enters the
  # working-tree hash. Without this the hook's `git add -A` would fold the
  # dossier into the hash and never match what the auditor computed.
  printf '.claude/.last-verdict.json\n' > "$d/.gitignore"
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

# Fake session transcript whose LAST assistant message is $2 (prior assistant
# messages may follow as $3..; they are written first). Mirrors the real JSONL
# shape: {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}.
write_transcript() {
  local repo="$1" last="$2"; shift 2
  : > "$repo/transcript.jsonl"
  local earlier
  for earlier in "$@"; do
    jq -nc --arg t "$earlier" \
      '{type:"assistant", message:{content:[{type:"text",text:$t}]}}' >> "$repo/transcript.jsonl"
  done
  jq -nc --arg t "$last" \
    '{type:"assistant", message:{content:[{type:"text",text:$t}]}}' >> "$repo/transcript.jsonl"
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

# Run the hook inside repo and classify the decision. Uses the repo's fake
# transcript when present, /dev/null otherwise.
decide() {
  local repo="$1" out d tp="/dev/null"
  [[ -f "$repo/transcript.jsonl" ]] && tp="$repo/transcript.jsonl"
  local payload; payload="$(jq -nc --arg p "$tp" '{transcript_path:$p, hook_event_name:"Stop"}')"
  # Decision-logic cases run in HARD mode so a block condition is observable as
  # decision:block. Soft mode is covered in its own section below.
  out="$(printf '%s' "$payload" | ( cd "$repo" && CLAUDE_PROJECT_DIR="$repo" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
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

# Assert the dossier file is gone (consumed on allow, or discarded on mismatch).
check_gone() {  # desc  repo
  local desc="$1" repo="$2"
  if [[ ! -e "$repo/.claude/.last-verdict.json" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (dossier still present)\n' "$desc"
  fi
}

echo "## Detection: no dossier → the final assistant message decides"
R="$(setup)"; write_transcript "$R" "The root cause is a race between gvproxy startup and the socket bind."
check "'root cause is X' → block (verdict asserted, unaudited)"   "$R" "block"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Rolled the canary back; prod looks healthy again, error rate is flat."
check "'prod looks healthy' → block"                              "$R" "block"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "All tests pass: 23/23 on the hook suite."
check "'tests pass' → block"                                      "$R" "block"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Done."
check "bare 'Done.' → block"                                      "$R" "block"; rm -rf "$R"

# Sentence-initial assertion without a helper verb — caught a live false negative
# in the transcript sweep ("Confirmed reachable from the open internet.").
R="$(setup)"; write_transcript "$R" "Confirmed reachable from the open internet."
check "sentence-initial 'Confirmed <adj>' → block"                "$R" "block"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Which of the two layouts do you prefer for the config module?"
check "question → allow"                                          "$R" "allow"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Here are three options for the retry policy, with trade-offs for each."
check "neutral discussion → allow"                                "$R" "allow"; rm -rf "$R"

# Detection reads only the LAST message — an old verdict earlier in the session
# must not retrigger on a later chat turn.
R="$(setup)"; write_transcript "$R" "What should I look at next?" "The root cause is the stale cache."
check "earlier verdict, last msg is a question → allow"           "$R" "allow"; rm -rf "$R"

# Verdict phrasing quoted inside code spans/fences is documentation, not a claim.
R="$(setup)"; write_transcript "$R" 'The matcher looks for phrases like `tests pass` and `root cause is` in prose:
```
detector: "tests pass" -> block
```
Nothing is asserted here.'
check "verdict phrases only inside code → allow"                  "$R" "allow"; rm -rf "$R"

R="$(setup)"  # no transcript at all (payload points at /dev/null)
check "no transcript → allow (fail-open)"                         "$R" "allow"; rm -rf "$R"

echo
echo "## Present dossier, fresh + matching → the verdict decides"
R="$(setup)"; write_transcript "$R" "Fix verified; tests pass."; write_verdict "$R" "PASS" "[]"
check "PASS → allow"                                              "$R" "allow"
check_gone "PASS dossier consumed on allow"                       "$R"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Root cause confirmed; pausing here."; write_verdict "$R" "IN_PROGRESS" '["push pending"]'
check "IN_PROGRESS → allow"                                       "$R" "allow"
check_gone "IN_PROGRESS dossier consumed on allow"                "$R"; rm -rf "$R"

# Requirement: the gate MAY loop on real findings — FAIL persists until re-audited.
R="$(setup)"; write_transcript "$R" "The fix works."; write_verdict "$R" "FAIL" '["Test: no reproducer for the claimed fix"]'
check "FAIL → block (finding-driven loop)"                        "$R" "block"
check "FAIL again (unaddressed) → still block"                    "$R" "block"; rm -rf "$R"

echo
echo "## Present dossier, stale/mismatched binding → DISCARD + re-detect (never a bookkeeping block)"
# Tree moved after the audit, but the turn ends on a chat message → the old
# dossier is discarded and the turn ends freely. Under #915 this BLOCKED — that
# was the meaningless re-audit class.
R="$(setup)"; write_transcript "$R" "Noted — I'll wait for your call on the API shape."
write_verdict "$R" "PASS" "[]"; printf 'more\n' >> "$R/src/lib.rs"
check "tree moved + chat ending → allow"                          "$R" "allow"
check_gone "mismatched dossier discarded"                         "$R"; rm -rf "$R"

# Tree moved after the audit AND the turn still asserts a verdict → the discard
# falls through to detection, which demands a FRESH audit of the current claim.
R="$(setup)"; write_transcript "$R" "Applied the follow-up; the fix works and tests pass."
write_verdict "$R" "PASS" "[]"; printf 'more\n' >> "$R/src/lib.rs"
check "tree moved + verdict ending → block (fresh audit)"         "$R" "block"
check_gone "mismatched dossier discarded before re-detect"        "$R"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Thanks, ending here."; write_verdict "$R" "FAIL" '["x"]'
jq '.head="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"' "$R/.claude/.last-verdict.json" > "$R/.claude/x" \
  && mv "$R/.claude/x" "$R/.claude/.last-verdict.json"
check "HEAD-mismatched FAIL + chat ending → allow (discarded)"    "$R" "allow"
check_gone "HEAD-mismatched dossier discarded"                    "$R"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Deploy is healthy."; write_verdict "$R" "PASS" "[]"
touch -t 202001010000 "$R/.claude/.last-verdict.json"
check "stale-mtime PASS + verdict ending → block (re-detect)"     "$R" "block"; rm -rf "$R"

echo
echo "## Soft mode (VERDICT_GATE_HARD_BLOCK unset/0): block conditions become nudges"
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
soft_out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$soft_out" | jq -e '(.decision // "") != "block" and .continue == true and (.systemMessage | type) == "string"' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "detected verdict → nudge in soft mode, not block"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (out=%s)\n' "soft-mode detection nudge" "$soft_out"
fi
rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Anything else you want changed?"
soft_chat="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
hard_chat="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
if [[ -z "$soft_chat" && -z "$hard_chat" ]]; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "chat turn → allow (empty) in soft AND hard"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (soft=%s hard=%s)\n' "chat allow" "$soft_chat" "$hard_chat"
fi
rm -rf "$R"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
