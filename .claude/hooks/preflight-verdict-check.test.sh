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

# Hermetic triage: force the classifier into UNKNOWN (command fails) so every case
# below exercises the deterministic regex fallback unless a case overrides the stub.
# Without this, a machine with the `claude` CLI would call a live model mid-suite.
export VERDICT_CLASSIFIER_CMD='false'

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
# shape: {"type":"assistant","uuid":..., "message":{"content":[{"type":"text",...}]}}.
# The last message gets uuid "uuid-last", earlier ones "uuid-<n>".
write_transcript() {
  local repo="$1" last="$2"; shift 2
  : > "$repo/transcript.jsonl"
  local earlier n=0
  for earlier in "$@"; do
    n=$((n+1))
    jq -nc --arg t "$earlier" --arg u "uuid-$n" \
      '{type:"assistant", uuid:$u, message:{content:[{type:"text",text:$t}]}}' >> "$repo/transcript.jsonl"
  done
  jq -nc --arg t "$last" --arg u "uuid-last" \
    '{type:"assistant", uuid:$u, message:{content:[{type:"text",text:$t}]}}' >> "$repo/transcript.jsonl"
}

# Codex-format transcript (rollout JSONL): response_item / payload.role=assistant /
# content[].output_text, no per-record id. Same last-message-wins semantics.
write_codex_transcript() {
  local repo="$1" last="$2"
  jq -nc --arg t "$last" \
    '{type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text:$t}]}}' \
    > "$repo/transcript.jsonl"
}

# An INVENTED schema no harness uses today — proves new agents work with zero hook
# changes as long as they follow the conventions (role=assistant somewhere, text
# under `text` keys in *text-typed blocks, JSONL).
write_future_agent_transcript() {
  local repo="$1" last="$2"
  jq -nc --arg t "$last" \
    '{kind:"turn", actor:{role:"assistant"}, output:{parts:[{type:"rich_text", text:$t}]}}' \
    > "$repo/transcript.jsonl"
}

# The content-derived message identity the hook records (keep formula in sync).
cksum_of() { printf 'cksum-%s' "$(printf '%s' "$1" | cksum | tr ' \t' '--')"; }

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
echo "## Triage (intelligent trigger): classifier decides; regex is the fallback"
# The classifier stub receives the stripped message on stdin and answers YES/NO.
# YES on a message the regex would MISS → the intelligence adds recall.
R="$(setup)"; write_transcript "$R" "The culprit was the stale socket path all along."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD='cat >/dev/null; echo YES' bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "classifier YES on regex-miss phrasing → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "classifier YES → block" "$out"
fi; rm -rf "$R"

# NO on a message the regex would HIT (quoting/discussion) → intelligence removes
# the static false positive.
R="$(setup)"; write_transcript "$R" "In prose people write things like tests pass or root cause is X when they conclude."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD='cat >/dev/null; echo NO' bash "$HOOK" ) 2>/dev/null)"
if [[ -z "$out" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "classifier NO on regex-hit phrasing → allow (FP removed)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "classifier NO → allow" "$out"
fi; rm -rf "$R"

# Classifier unavailable / garbage → UNKNOWN → deterministic regex fallback still gates.
R="$(setup)"; write_transcript "$R" "All tests pass: 23/23 on the hook suite."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD='cat >/dev/null; echo MAYBE' bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "classifier garbage → regex fallback → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "garbage → regex fallback" "$out"
fi; rm -rf "$R"

echo
echo "## Flush-race guard: never judge a message that was already judged"
# The harness may fire Stop before appending the turn's final message; the last
# transcript entry is then the PREVIOUS turn's (already gated) message. The hook
# records the identity it judged (checksum of the text — harness-agnostic);
# seeing the same identity again → allow, never re-block.
R="$(setup)"; write_transcript "$R" "Fix verified; tests pass."   # verdict-shaped
mkdir -p "$R/.claude"; cksum_of "Fix verified; tests pass." > "$R/.claude/.verdict-last-uuid"
check "stale transcript (identity already judged) → allow"       "$R" "allow"; rm -rf "$R"

# Normal path records the judged identity so the NEXT stale sighting is recognized.
R="$(setup)"; write_transcript "$R" "Deploy is healthy."
got="$(decide "$R")"
recorded="$(cat "$R/.claude/.verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$got" == "block" && "$recorded" == "$(cksum_of "Deploy is healthy.")" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "detection block records the judged identity"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s recorded=%s)\n' "identity recorded on block" "$got" "$recorded"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Anything else to adjust?"
got="$(decide "$R")"
recorded="$(cat "$R/.claude/.verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$got" == "allow" && "$recorded" == "$(cksum_of "Anything else to adjust?")" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "detection allow records the judged identity"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s recorded=%s)\n' "identity recorded on allow" "$got" "$recorded"
fi; rm -rf "$R"

echo
echo "## Harness-agnostic extraction: conventions, not schema lists"
R="$(setup)"; write_codex_transcript "$R" "Root cause is the missing bind mount; all tests pass now."
check "codex rollout schema, verdict → block"                    "$R" "block"
recorded="$(cat "$R/.claude/.verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$recorded" == cksum-* ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "codex record (no id) → checksum identity recorded"
else
  fail=$((fail+1)); printf '  FAIL  %s  (recorded=%s)\n' "checksum identity" "$recorded"
fi; rm -rf "$R"

R="$(setup)"; write_codex_transcript "$R" "Which retry policy do you prefer here?"
check "codex rollout schema, chat → allow"                       "$R" "allow"; rm -rf "$R"

# Race guard on content identity: same text → same checksum → stale.
R="$(setup)"; write_codex_transcript "$R" "Deploy is healthy."
mkdir -p "$R/.claude"; cksum_of "Deploy is healthy." > "$R/.claude/.verdict-last-uuid"
check "codex stale (identity already judged) → allow"            "$R" "allow"; rm -rf "$R"

# The acceptance test for "all kinds of coding agents": a schema NO harness uses
# today must work with ZERO hook changes.
R="$(setup)"; write_future_agent_transcript "$R" "Root cause is the stale DNS cache; fix verified."
check "invented future-agent schema, verdict → block"            "$R" "block"; rm -rf "$R"

R="$(setup)"; write_future_agent_transcript "$R" "Want me to sketch the two options first?"
check "invented future-agent schema, chat → allow"               "$R" "allow"; rm -rf "$R"

# VERDICT_EXTRACTOR_CMD: the escape hatch for a truly alien (non-JSONL) format.
R="$(setup)"; printf 'PLAIN TEXT LOG. verdict: tests pass\n' > "$R/transcript.jsonl"
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_EXTRACTOR_CMD='tail -n1' bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "custom extractor (non-JSONL format) → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "custom extractor" "$out"
fi; rm -rf "$R"

echo
echo "## Chinese fallback patterns"
R="$(setup)"; write_transcript "$R" "排查结束：根因是 gvproxy 套接字路径冲突，已修复。"
check "中文 verdict (根因是/已修复) → block"                       "$R" "block"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "接下来你想先看哪个模块？我可以先画个调用图。"
check "中文 chat → allow"                                         "$R" "allow"; rm -rf "$R"

echo
echo "## Decision log: every Stop decision leaves one greppable line"
R="$(setup)"; write_transcript "$R" "Deploy is healthy."
decide "$R" >/dev/null
if grep -q ' regex match-block$' "$R/.claude/.verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "block decision logged (rung + outcome)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "block logged" "$(cat "$R/.claude/.verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Anything else to adjust?"
decide "$R" >/dev/null
if grep -q ' regex none-allow$' "$R/.claude/.verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "allow decision logged"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "allow logged" "$(cat "$R/.claude/.verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Fix verified; tests pass."; write_verdict "$R" "PASS" "[]"
decide "$R" >/dev/null
if grep -q ' dossier PASS-allow$' "$R/.claude/.verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "dossier consumption logged"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "dossier logged" "$(cat "$R/.claude/.verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

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
