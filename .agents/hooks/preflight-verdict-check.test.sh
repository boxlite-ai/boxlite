#!/usr/bin/env bash
# Tests for .agents/hooks/preflight-verdict-check.sh (the Stop-stage verdict gate).
#
# The hook is DETECTION-TRIGGERED, with finding-driven loops only:
#   - no dossier + the turn asserts a verdict ("root cause is X",
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
# Stop contract: block = stdout {"decision":"block"}; allow = exit 0 with either
# empty stdout or {"continue":true, systemMessage:...} — the systemMessage is the
# human-only triage announcement (the model never sees it; documented hook
# contract). decide() treats any non-block output as allow.
#
# Run with:  bash .agents/hooks/preflight-verdict-check.test.sh
# Exits non-zero on any failure.
set -uo pipefail

# Hermetic baseline: drop any ambient VERDICT_GATE_HARD_BLOCK so absence is the
# starting point regardless of the caller's environment. Absent now means HARD, so
# every case that wants soft mode sets VERDICT_GATE_HARD_BLOCK=0 explicitly rather
# than relying on the unset — see the unset⇒block case below, which pins that.
unset VERDICT_GATE_HARD_BLOCK

# Hermetic triage: force the classifier into UNKNOWN (command fails) so every case
# below exercises the deterministic regex fallback unless a case overrides the stub.
# Without this, a machine with the `claude` CLI would call a live model mid-suite.
export VERDICT_CLASSIFIER_CMD='false'
# Its matched seam. Left ambient it replaces the text every case asserts on, so the
# suite grades a transcript it never wrote — 29/25 with `true`, 46/8 with `cat`.
unset VERDICT_EXTRACTOR_CMD

# Resolve from THIS script's location, not the caller's cwd. `git rev-parse
# --show-toplevel` returns whichever checkout the shell sits in, so running this
# suite from another worktree silently tests THAT checkout's copy instead of the
# one shipped beside these tests, and a two-side check reports a false pass.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.agents/hooks/preflight-verdict-check.sh"

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
  # Mirror the real repo, which ignores the whole state dir: gate-written state must
  # never enter the working-tree hash, or `git add -A` folds it into the very hash the
  # dossier is keyed to and self-invalidates a just-passed audit. Ignoring the
  # directory (not one file) keeps this true for every marker the gates write —
  # last-verdict.prev.json, verdict-last-uuid, verdict-decisions.log.
  printf '.agents/state/\n' > "$d/.gitignore"
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

# Append records to an existing fixture transcript: a REAL user message (turn
# boundary) or a further assistant text (same turn as its neighbors).
append_user() {
  jq -nc --arg t "$2" '{type:"user", message:{content:[{type:"text",text:$t}]}}' >> "$1/transcript.jsonl"
}
append_assistant() {
  jq -nc --arg t "$2" '{type:"assistant", message:{content:[{type:"text",text:$t}]}}' >> "$1/transcript.jsonl"
}
# Tool results ride user-role records. The array shape (produced by Read, Agent,
# ToolSearch, MCP tools) nests text-typed blocks INSIDE the tool_result — it must
# NOT read as a turn boundary.
append_tool_result_array() {
  jq -nc --arg t "$2" \
    '{type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id:"tu1", content:[{type:"text", text:$t}]}]}}' \
    >> "$1/transcript.jsonl"
}
append_tool_result_string() {
  jq -nc --arg t "$2" \
    '{type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id:"tu1", content:$t}]}}' \
    >> "$1/transcript.jsonl"
}

# Write a dossier; tree_hash defaults to the repo's current working-tree hash.
write_verdict() {
  local repo="$1" verdict="$2" findings="$3" tree="${4:-$(tree_hash_of "$1")}"
  local br hd; br="$(git -C "$repo" branch --show-current)"; hd="$(git -C "$repo" rev-parse HEAD)"
  mkdir -p "$repo/.agents/state"
  jq -nc --arg b "$br" --arg h "$hd" --arg t "$tree" --arg v "$verdict" --argjson f "$findings" \
    '{branch:$b, head:$h, tree_hash:$t, verdict:$v, proof:[], findings:$f}' \
    > "$repo/.agents/state/last-verdict.json"
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
  if [[ ! -e "$repo/.agents/state/last-verdict.json" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (dossier still present)\n' "$desc"
  fi
}

# A classifier stub that RECORDS its own invocation. Tiers A and B are latency work,
# so what has to be asserted is that the 5-10s round-trip was genuinely SKIPPED — not
# merely that its answer agreed. The stub also answers the OPPOSITE of the tier under
# test, so a run without the tier reaches the model and lands on the wrong decision.
# (Same property the in-flight rung needs: it sits ahead of triage.)
cls_stub()      { printf "cat >/dev/null; touch '%s/CLASSIFIER_RAN'; echo %s" "$1" "$2"; }
classifier_ran() { [[ -e "$1/CLASSIFIER_RAN" ]] && echo yes || echo no; }
run_hook() {  # repo  classifier-answer
  jq -nc --arg p "$1/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
    | ( cd "$1" && CLAUDE_PROJECT_DIR="$1" VERDICT_GATE_HARD_BLOCK=1 \
        VERDICT_CLASSIFIER_CMD="$(cls_stub "$1" "$2")" bash "$HOOK" ) 2>/dev/null
}

# ── Real-repo invariant: every gate-written .agents/state/ file is gitignored ──
# compute_tree_hash() folds the whole working tree into the dossier binding via
# `git add -A`, which SKIPS gitignored paths. So every file the gates write under
# .agents/state/ MUST be gitignored — otherwise writing it perturbs the very tree
# hash the dossier is keyed to and self-invalidates a just-passed audit (the
# class of bug that hit pr-reviewed.json: a fresh PASS discarded as "stale" the
# instant the PR-review ack was written). setup() emulates this per synthetic
# repo (only last-verdict.json); this case guards the REAL .gitignore for the
# whole class, so a new marker added without a matching ignore line fails here.
echo "## Invariant: gate state files are gitignored (never enter the tree hash)"
for f in \
  .agents/state/last-audit.json \
  .agents/state/last-verdict.json \
  .agents/state/last-verdict.prev.json \
  .agents/state/pr-reviewed.json \
  .agents/state/verdict-last-uuid \
  .agents/state/verdict-audit.lock \
  .agents/state/verdict-decisions.log; do
  if git -C "$REPO_ROOT" check-ignore -q "$f"; then
    pass=$((pass + 1)); printf '  PASS  %s gitignored\n' "$f"
  else
    fail=$((fail + 1)); printf '  FAIL  %s NOT gitignored → would perturb compute_tree_hash\n' "$f"
  fi
done

echo
echo "## Detection: no dossier → the turn text decides"
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

# Detection reads only the FINAL TURN — a verdict in a PREVIOUS turn (separated
# by a real user message) must not retrigger on a later chat turn.
R="$(setup)"; write_transcript "$R" "The root cause is the stale cache."
append_user "$R" "thanks — and what should I look at next?"
append_assistant "$R" "What to look at next depends on the retry budget you want."
check "previous-turn verdict, new chat turn → allow"              "$R" "allow"; rm -rf "$R"

# Verdict phrasing quoted inside code spans/fences is documentation, not a claim.
R="$(setup)"; write_transcript "$R" 'The matcher looks for phrases like `tests pass` and `root cause is` in prose:
```
detector: "tests pass" -> block
```
Nothing is asserted here.'
check "verdict phrases only inside code → allow"                  "$R" "allow"; rm -rf "$R"

R="$(setup)"  # no transcript at all (payload points at /dev/null)
check "no transcript → allow (fail-open)"                         "$R" "allow"; rm -rf "$R"

# ── The gate must never end a turn it could not SEE ──────────────────────────
# A zero-byte/absent transcript is genuinely nothing to judge → allow at once, and the
# rung must say `empty` so it stays distinguishable from being blind.
R="$(setup)"
decide "$R" >/dev/null
if grep -q ' extract empty-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "no transcript → allow logged as empty (not blind)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "no-transcript rung" \
    "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

# THE REPRODUCER. A transcript WITH content but no assistant text means the hook read
# the file before the harness flushed the turn — the text lands moments later and the
# turn must still be judged on it. Observed live at 06:06:18Z: the text record's own
# timestamp was 0.1s after the hook's read, the turn logged `extract empty-allow`, and
# a verdict-shaped turn ended completely untriaged.
R="$(setup)"
jq -nc '{type:"user", message:{content:[{type:"text",text:"go"}]}}' > "$R/transcript.jsonl"
( sleep 0.6
  jq -nc '{type:"assistant", uuid:"uuid-last", message:{content:[{type:"text",
     text:"Root cause is the stale index; 12/12 tests pass."}]}}' >> "$R/transcript.jsonl" ) &
late_writer=$!
got="$(decide "$R")"
wait "$late_writer" 2>/dev/null
if [[ "$got" == "block" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "text flushed mid-wait → turn is judged, not skipped"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s — the turn ended unjudged)\n' "late-flush turn judged" "$got"
fi; rm -rf "$R"

# Content present but the turn genuinely never produces assistant text: still fail open
# (never trap on absent state), but under a rung that ADMITS the gate was blind.
R="$(setup)"
jq -nc '{type:"user", message:{content:[{type:"text",text:"go"}]}}' > "$R/transcript.jsonl"
got="$(decide "$R")"
if [[ "$got" == "allow" ]] && grep -q ' extract blind-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "still no assistant text after the wait → allow, logged blind"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s log=%s)\n' "blind rung" "$got" \
    "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

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
echo "## Audit in flight → allow (the gate must not busy-wait on its own remedy)"
# Regression: 108 blocks in one session, 39 in a 512s window, while the audit the gate
# demanded was still running. Each conjunct gets its own case — the rung must suppress
# only the window where no verdict provably exists yet.
lock_path() { printf '%s/.agents/state/verdict-audit.lock' "$1"; }
# $2 = body VERBATIM; cases write malformed and legacy bodies too, so this must not
# encode the format. See take_audit_lock() in run-verdict-audit.sh.
take_lock()  { mkdir -p "$1/.agents/state"; printf '%s' "$2" > "$(lock_path "$1")"; }
now_epoch()  { date +%s; }
# BSD `date -r` / GNU `date -d @`. The suite's other backdating uses a fixed 2020 stamp,
# useless here because the deadline ceiling is anchored TO the mtime.
backdate() {  # file  seconds-ago
  local target=$(( $(date +%s) - $2 )) stamp
  stamp="$(date -r "$target" +%Y%m%d%H%M.%S 2>/dev/null \
        || date -d "@$target" +%Y%m%d%H%M.%S 2>/dev/null)"
  [[ -n "$stamp" ]] && touch -t "$stamp" "$1"
}

sleep 300 & LIVE_PID=$!            # stands in for a running run-verdict-audit.sh

# The rung sits ahead of triage, so the 5-10s model round-trip must be skipped too —
# the stub answers YES, which is what a hook WITHOUT the rung would block on.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
take_lock "$R" "$LIVE_PID"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1 \
   && grep -q ' audit inflight-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null \
   && [[ ! -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "audit running, no verdict yet → allow (classifier skipped)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s ran=%s log=%s)\n' "in-flight rung" "$out" \
    "$(classifier_ran "$R")" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

# A dead runner must not buy silence: the EXIT trap misses SIGKILL, so an interrupted
# session orphans the lock.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
sleep 0 & DEAD_PID=$!; wait "$DEAD_PID" 2>/dev/null
take_lock "$R" "$DEAD_PID"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "lock held by a DEAD pid → block (no bypass)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "dead-runner lock bought silence" "$out"
fi; rm -rf "$R"

# A bare-PID body has no deadline, so it takes the max_age_seconds fallback — not the
# general rule; a body carrying a deadline gets the wider bound (see the 800s case).
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
take_lock "$R" "$LIVE_PID"; touch -t 202001010000 "$(lock_path "$R")"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "lock older than max_age → block (pid reuse bounded)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "aged lock bought silence" "$out"
fi; rm -rf "$R"

# THE soundness case. The runner removes the dossier before auditing, so a present one
# means this run already answered (the auditor writes mid-run). A held lock must not
# mute it, or a real FAIL is skippable for the runner's whole tail.
R="$(setup)"; write_transcript "$R" "The fix works."
write_verdict "$R" "FAIL" '["Test: no reproducer for the claimed fix"]'
take_lock "$R" "$LIVE_PID"
check "verdict already written → FAIL blocks despite the held lock"  "$R" "block"; rm -rf "$R"

# Untrusted input: anything that is not a PID says nothing about liveness. "0" is the
# dangerous one — `kill -0 0` hits the caller's own process group and SUCCEEDS, so a
# bare numeric check would let it past the liveness conjunct.
for junk in "" "0" "not-a-pid" "12x34" "-1"; do
  R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
  take_lock "$R" "$junk"
  out="$(run_hook "$R" YES)"
  if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
    pass=$((pass+1)); printf '  PASS  %s\n' "lock content '${junk:-<empty>}' is not a live pid → block"
  else
    fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "non-pid lock content '${junk:-<empty>}' bought silence" "$out"
  fi; rm -rf "$R"
done

# Models a long run partway through: the lock is ALREADY older than max_age_seconds, so
# a hook that ignores the deadline and falls back to the mtime bound fails here.
# Backdated 700s, not to 2020, because the ceiling is anchored to the mtime.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
take_lock "$R" "$LIVE_PID $(( $(now_epoch) + 800 ))"; backdate "$(lock_path "$R")" 700
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "deadline beyond max_age_seconds → still allow (long audits covered)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "lock expired mid-run despite its deadline" "$out"
fi; rm -rf "$R"

# ...but the deadline is file content, not a promise. Past it, the run is over however
# alive the PID looks.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
take_lock "$R" "$LIVE_PID $(( $(now_epoch) - 30 ))"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "deadline already passed → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "expired deadline bought silence" "$out"
fi; rm -rf "$R"

# A lock cannot buy itself unbounded silence by claiming a deadline years out.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
take_lock "$R" "$LIVE_PID $(( $(now_epoch) + 86400 ))"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "deadline past the hard ceiling → block (rejected, not capped)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "an unbounded deadline was honoured" "$out"
fi; rm -rf "$R"

# Composition with the discard path, which is how a re-audit round actually looks: the
# agent fixed the findings (tree moved), the old dossier is discarded as mismatched, and
# a runner is already recomputing the verdict. The dossier branch must not consume its
# way past this rung, and the discarded dossier must not resurrect as a block.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
write_verdict "$R" "FAIL" '["Test: no reproducer for the claimed fix"]'
printf 'moved\n' >> "$R/src/lib.rs"            # invalidates the binding
take_lock "$R" "$LIVE_PID $(( $(now_epoch) + 800 ))"
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1 \
   && [[ ! -e "$R/.agents/state/last-verdict.json" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "stale dossier discarded + audit in flight → allow"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s dossier=%s)\n' "discard→in-flight composition" "$out" \
    "$([[ -e "$R/.agents/state/last-verdict.json" ]] && echo present || echo gone)"
fi; rm -rf "$R"

kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null

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
jq '.head="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"' "$R/.agents/state/last-verdict.json" > "$R/.agents/state/x" \
  && mv "$R/.agents/state/x" "$R/.agents/state/last-verdict.json"
check "HEAD-mismatched FAIL + chat ending → allow (discarded)"    "$R" "allow"
check_gone "HEAD-mismatched dossier discarded"                    "$R"; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Deploy is healthy."; write_verdict "$R" "PASS" "[]"
touch -t 202001010000 "$R/.agents/state/last-verdict.json"
check "stale-mtime PASS + verdict ending → block (re-detect)"     "$R" "block"; rm -rf "$R"

echo
echo "## Tier A: harness text in the assistant slot decides without a model call"
# The assistant slot also carries text the HARNESS wrote — API errors, quota notices,
# interruption markers. No model produced it, so it asserts nothing and can never be a
# verdict. 81 of 563 real turns in this repo's transcripts (14.4%) are exactly this,
# and each one used to buy a 5-10s classifier round-trip to be told "NO".
R="$(setup)"; write_transcript "$R" "API Error: 400 Your input exceeds the context window of this model."
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1 && [[ ! -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "harness API error only → allow, classifier never invoked"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s classifier_ran=%s)\n' "tier A skips the model" "$out" "$(classifier_ran "$R")"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "No response requested."
out="$(run_hook "$R" YES)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1 && [[ ! -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "harness 'No response requested.' → allow, classifier never invoked"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s classifier_ran=%s)\n' "tier A on quota//status text" "$out" "$(classifier_ran "$R")"
fi; rm -rf "$R"

# SOUNDNESS — why EVERY non-empty line must match, not just the first. A turn that did
# real work and then hit an error still owes proof... The stub says NO, so a tier A that
# wrongly swallowed these would allow, and so would a hook with no tiers at all.
R="$(setup)"; write_transcript "$R" "Root cause is the stale socket path; 12/12 tests pass."
append_assistant "$R" "API Error: Overloaded"
out="$(run_hook "$R" NO)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "real verdict THEN harness error → block (not swallowed)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "trailing harness error swallowed the verdict" "$out"
fi; rm -rf "$R"

# ...and so does the reverse order, which is exactly what a first-line-only anchor
# leaks: a transient error, then a retry that states the verdict in the same turn.
R="$(setup)"; write_transcript "$R" "API Error: Overloaded"
append_assistant "$R" "Root cause is the stale socket path; 12/12 tests pass."
out="$(run_hook "$R" NO)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "harness error THEN real verdict → block (not swallowed)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "leading harness error swallowed the verdict" "$out"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "API Error: Overloaded"
decide "$R" >/dev/null
if grep -q ' harness noise-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "tier A decision logged (rung + outcome)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "tier A logged" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

echo
echo "## Tier B: assertion-only claims block without consulting the model"
# Stub answers NO throughout, so a hook without tier B reaches the model and allows.
R="$(setup)"; write_transcript "$R" "Reran the suite: 173/173 tests pass on the hook harness."
out="$(run_hook "$R" NO)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1 && [[ ! -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "'173/173 tests pass' → block, classifier never invoked"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s classifier_ran=%s)\n' "tier B skips the model" \
    "$out" "$([[ -e "$R/CLASSIFIER_RAN" ]] && echo yes || echo no)"
fi; rm -rf "$R"

# PRECISION — the entire reason the promoted set is a small subset. A turn merely
# DISCUSSING verdict wording must still reach the classifier and be allowed; that is
# what the ambiguous majority ("tests pass", "root cause is", "deploy is healthy")
# stays behind the model for. Reaching the stub proves tier B declined.
R="$(setup)"; write_transcript "$R" "In prose people write things like tests pass or root cause is X or deploy is healthy."
out="$(run_hook "$R" NO)"
if printf '%s' "$out" | jq -e '(.decision // "") != "block"' >/dev/null 2>&1 && [[ -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "discussion of verdict wording → reaches the model, allowed"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s classifier_ran=%s)\n' "tier B precision" \
    "$out" "$(classifier_ran "$R")"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Verified the socket path resolves under the jailer."
out="$(run_hook "$R" NO)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1 && [[ ! -e "$R/CLASSIFIER_RAN" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "line-initial 'Verified …' → block, classifier never invoked"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s classifier_ran=%s)\n' "tier B line-initial form" \
    "$out" "$(classifier_ran "$R")"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "26/26 tests pass."
decide "$R" >/dev/null
if grep -q ' assertion match-block$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "tier B decision logged (rung + outcome)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "tier B logged" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

echo
echo "## Slow path: a FAILed dossier survives the fix that invalidates its binding"
# Observed cycle before this: FAIL-block → agent fixes → tree moves → discard-stale →
# re-detect → block → a full COLD re-audit, every round. Parking the FAIL lets round
# N+1 re-check known findings against the delta instead of re-deriving everything.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
write_verdict "$R" "FAIL" '["tests-pass: no re-runnable command named"]' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
decide "$R" >/dev/null
if jq -e '.verdict == "FAIL"' "$R/.agents/state/last-verdict.prev.json" >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "FAIL dossier parked as prev when the binding goes stale"
else
  fail=$((fail+1)); printf '  FAIL  %s  (prev=%s)\n' "FAIL parked as prev" \
    "$(cat "$R/.agents/state/last-verdict.prev.json" 2>/dev/null || echo MISSING)"
fi
check_gone "…live dossier still discarded (re-detect, never block on bookkeeping)" "$R"; rm -rf "$R"

# An AGED-OUT FAIL means nobody acted on those findings and the round is over. Parking
# it would hand the next audit findings about unrelated work — observed live, a FAIL
# from 04:46 still being offered at 05:37 to an auditor judging a different task.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
write_verdict "$R" "FAIL" '["tests-pass: no re-runnable command named"]'
touch -t 202001010000 "$R/.agents/state/last-verdict.json"
decide "$R" >/dev/null
if [[ ! -e "$R/.agents/state/last-verdict.prev.json" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "aged-out FAIL is dropped, not parked"
else
  fail=$((fail+1)); printf '  FAIL  %s  (prev=%s)\n' "aged-out FAIL wrongly parked" \
    "$(cat "$R/.agents/state/last-verdict.prev.json" 2>/dev/null)"
fi; rm -rf "$R"

# A PASS/IN_PROGRESS that merely aged out carries nothing to re-check — it must not
# masquerade as a failed round.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
write_verdict "$R" "PASS" '[]' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
decide "$R" >/dev/null
if [[ ! -e "$R/.agents/state/last-verdict.prev.json" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "stale PASS is dropped, not parked"
else
  fail=$((fail+1)); printf '  FAIL  %s\n' "stale PASS wrongly parked as a failed round"
fi; rm -rf "$R"

# Parking is inert unless the findings actually reach the auditor.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
mkdir -p "$R/.agents/state"
printf '{"verdict":"FAIL","findings":["tests-pass: no command named"]}' > "$R/.agents/state/last-verdict.prev.json"
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.reason | test("last-verdict.prev.json")' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "block instruction hands the prior findings to the auditor"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "prior findings reach the auditor" "$out"
fi; rm -rf "$R"

# An UNCLAIMED park expires too. Age-gating only the write bounds staleness at park time,
# but this file is read on every later block — so an abandoned round (user changed topic,
# no re-audit ever ran) would keep feeding dead findings to an auditor judging unrelated
# work, and "a finding you cannot confirm as addressed stays a finding" turns those into a
# manufactured FAIL.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
mkdir -p "$R/.agents/state"
printf '{"verdict":"FAIL","findings":["stale round, never claimed"]}' > "$R/.agents/state/last-verdict.prev.json"
touch -t 202001010000 "$R/.agents/state/last-verdict.prev.json"
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
if ! printf '%s' "$out" | jq -e '.reason | test("last-verdict.prev.json")' >/dev/null 2>&1 \
   && [[ ! -e "$R/.agents/state/last-verdict.prev.json" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "unclaimed parked FAIL expires, never reaches the next audit"
else
  fail=$((fail+1)); printf '  FAIL  %s  (prev_still_there=%s)\n' "stale park expired" \
    "$([[ -e "$R/.agents/state/last-verdict.prev.json" ]] && echo yes || echo no)"
fi; rm -rf "$R"

# ...but a freshly parked one is still offered, so expiry cannot swallow the live case.
# The second turn must carry DIFFERENT text: a real round writes a new turn after the fix,
# and reusing the first one trips the flush-race guard instead of reaching the park.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
write_verdict "$R" "FAIL" '["tests-pass: no re-runnable command named"]' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
decide "$R" >/dev/null                       # parks it
write_transcript "$R" "Reworked the index guard; the root cause is addressed."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.reason | test("last-verdict.prev.json")' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "a just-parked FAIL still reaches the next audit"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "fresh park survives expiry" "$out"
fi; rm -rf "$R"

# The cycle ended clean: a surviving prev would aim the next audit at resolved findings.
R="$(setup)"; write_transcript "$R" "Fix verified; tests pass."
mkdir -p "$R/.agents/state"
printf '{"verdict":"FAIL","findings":["x"]}' > "$R/.agents/state/last-verdict.prev.json"
write_verdict "$R" "PASS" "[]"
decide "$R" >/dev/null
if [[ ! -e "$R/.agents/state/last-verdict.prev.json" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "PASS consumption clears the parked FAIL"
else
  fail=$((fail+1)); printf '  FAIL  %s\n' "parked FAIL outlives the PASS that resolved it"
fi; rm -rf "$R"

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
if printf '%s' "$out" | jq -e '(.decision // "") != "block" and .continue == true and (.systemMessage | test("triage: NO"))' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "classifier NO → allow, announced to the human only"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "classifier NO → announced allow" "$out"
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
mkdir -p "$R/.agents/state"; cksum_of "Fix verified; tests pass." > "$R/.agents/state/verdict-last-uuid"
check "stale transcript (identity already judged) → allow"       "$R" "allow"; rm -rf "$R"

# Normal path records the judged identity so the NEXT stale sighting is recognized.
R="$(setup)"; write_transcript "$R" "Deploy is healthy."
got="$(decide "$R")"
recorded="$(cat "$R/.agents/state/verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$got" == "block" && "$recorded" == "$(cksum_of "Deploy is healthy.")" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "detection block records the judged identity"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s recorded=%s)\n' "identity recorded on block" "$got" "$recorded"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Anything else to adjust?"
got="$(decide "$R")"
recorded="$(cat "$R/.agents/state/verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$got" == "allow" && "$recorded" == "$(cksum_of "Anything else to adjust?")" ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "detection allow records the judged identity"
else
  fail=$((fail+1)); printf '  FAIL  %s  (got=%s recorded=%s)\n' "identity recorded on allow" "$got" "$recorded"
fi; rm -rf "$R"

echo
echo "## Turn-level extraction: mid-turn findings cannot hide behind closing narration"
# The classifier stub greps its stdin for the finding — proving the JOINED turn
# text (not just the trailing fragment) is what triage judges. This is the class
# a sibling session's decision log caught escaping: finding asserted mid-turn,
# turn ends on "let me check X".
GREP_STUB='text="$(cat)"; printf "%s" "$text" | grep -q "1:1 port" && echo YES || echo NO'

R="$(setup)"; write_transcript "$R" "The activity service is a 1:1 port of upstream; there is no auto-start in the proxy."
append_assistant "$R" "Let me check what the standalone proxy serves next."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD="$GREP_STUB" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "mid-turn finding + closing narration → block (joined text judged)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "mid-turn finding → block" "$out"
fi; rm -rf "$R"

# The dominant real-transcript shape: a tool call sits between the finding and
# the closing narration. ARRAY-shaped tool_results nest text blocks inside the
# tool_result — they must not split the turn (that miss shipped once).
R="$(setup)"; write_transcript "$R" "The activity service is a 1:1 port of upstream; there is no auto-start in the proxy."
append_tool_result_array "$R" "src/proxy.go: 200 lines, no timer, no activity import"
append_assistant "$R" "Let me check what the standalone proxy serves next."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD="$GREP_STUB" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "array tool_result mid-turn does not split the turn → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "array tool_result mid-turn" "$out"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "The activity service is a 1:1 port of upstream; there is no auto-start in the proxy."
append_tool_result_string "$R" "ok"
append_assistant "$R" "Let me check what the standalone proxy serves next."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD="$GREP_STUB" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "string tool_result mid-turn does not split the turn → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "string tool_result mid-turn" "$out"
fi; rm -rf "$R"

# Same finding but in a PREVIOUS turn (real user message between): the final
# turn is narration only — must not retrigger.
R="$(setup)"; write_transcript "$R" "The activity service is a 1:1 port of upstream; there is no auto-start in the proxy."
append_user "$R" "ok — check the proxy then"
append_assistant "$R" "Let me check what the standalone proxy serves next."
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD="$GREP_STUB" bash "$HOOK" ) 2>/dev/null)"
if ! printf '%s' "$out" | jq -e '(.decision // "") == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "same finding in a previous turn → allow (turn boundary respected)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "previous-turn finding → allow" "$out"
fi; rm -rf "$R"

# Codex rollout shape, same semantics: user boundary + two assistant texts join.
R="$(setup)"
jq -nc '{type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text", text:"compare with upstream"}]}}' > "$R/transcript.jsonl"
jq -nc '{type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text:"The activity service is a 1:1 port of upstream."}]}}' >> "$R/transcript.jsonl"
jq -nc '{type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text:"Let me check the proxy next."}]}}' >> "$R/transcript.jsonl"
out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=1 VERDICT_CLASSIFIER_CMD="$GREP_STUB" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass+1)); printf '  PASS  %s\n' "codex shape: mid-turn finding joined across records → block"
else
  fail=$((fail+1)); printf '  FAIL  %s  (out=%s)\n' "codex turn-level" "$out"
fi; rm -rf "$R"

echo
echo "## Harness-agnostic extraction: conventions, not schema lists"
R="$(setup)"; write_codex_transcript "$R" "Root cause is the missing bind mount; all tests pass now."
check "codex rollout schema, verdict → block"                    "$R" "block"
recorded="$(cat "$R/.agents/state/verdict-last-uuid" 2>/dev/null || echo MISSING)"
if [[ "$recorded" == cksum-* ]]; then
  pass=$((pass+1)); printf '  PASS  %s\n' "codex record (no id) → checksum identity recorded"
else
  fail=$((fail+1)); printf '  FAIL  %s  (recorded=%s)\n' "checksum identity" "$recorded"
fi; rm -rf "$R"

R="$(setup)"; write_codex_transcript "$R" "Which retry policy do you prefer here?"
check "codex rollout schema, chat → allow"                       "$R" "allow"; rm -rf "$R"

# Race guard on content identity: same text → same checksum → stale.
R="$(setup)"; write_codex_transcript "$R" "Deploy is healthy."
mkdir -p "$R/.agents/state"; cksum_of "Deploy is healthy." > "$R/.agents/state/verdict-last-uuid"
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
if grep -q ' regex match-block$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "block decision logged (rung + outcome)"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "block logged" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Anything else to adjust?"
decide "$R" >/dev/null
if grep -q ' regex none-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "allow decision logged"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "allow logged" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

R="$(setup)"; write_transcript "$R" "Fix verified; tests pass."; write_verdict "$R" "PASS" "[]"
decide "$R" >/dev/null
if grep -q ' dossier PASS-allow$' "$R/.agents/state/verdict-decisions.log" 2>/dev/null; then
  pass=$((pass+1)); printf '  PASS  %s\n' "dossier consumption logged"
else
  fail=$((fail+1)); printf '  FAIL  %s  (log=%s)\n' "dossier logged" "$(cat "$R/.agents/state/verdict-decisions.log" 2>/dev/null || echo MISSING)"
fi; rm -rf "$R"

echo
echo "## Soft mode (VERDICT_GATE_HARD_BLOCK=0 ONLY): block conditions become nudges"
# Soft is an EXPLICIT opt-out, not the default. It used to be reached by leaving the
# variable unset, which meant only Claude Code — the sole caller that sets it, via
# settings.json env — was ever gated; the Codex registration and any direct
# invocation silently got a nudge. The unset case is asserted to BLOCK below.
R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
soft_out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK=0 bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$soft_out" | jq -e '(.decision // "") != "block" and .continue == true and (.systemMessage | type) == "string"' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "detected verdict → nudge in soft mode, not block"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (out=%s)\n' "soft-mode detection nudge" "$soft_out"
fi
rm -rf "$R"

R="$(setup)"; write_transcript "$R" "The root cause is the stale index."
unset_out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
  | ( cd "$R" && env -u VERDICT_GATE_HARD_BLOCK CLAUDE_PROJECT_DIR="$R" bash "$HOOK" ) 2>/dev/null)"
if printf '%s' "$unset_out" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "unset VERDICT_GATE_HARD_BLOCK blocks (documented default is hard)"
else
  fail=$((fail + 1)); printf '  FAIL  %s  (out=%.120s)\n' "unset VERDICT_GATE_HARD_BLOCK blocks (documented default is hard)" "$unset_out"
fi
rm -rf "$R"

# One repo per mode. Both calls used to share one, and the first writes
# verdict-last-uuid, so the second returned "transcript unchanged since last
# judgment" without ever consulting its mode — this case named two modes and
# exercised one. Rejecting that short-circuit is part of the assertion: it is an
# allow like any other, so "neither blocked" alone would still pass on it.
chat_ok=yes
chat_detail=""
for chat_mode in 0 1; do
  R="$(setup)"; write_transcript "$R" "Anything else you want changed?"
  chat_out="$(jq -nc --arg p "$R/transcript.jsonl" '{transcript_path:$p, hook_event_name:"Stop"}' \
    | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_GATE_HARD_BLOCK="$chat_mode" bash "$HOOK" ) 2>/dev/null)"
  if [[ -n "$chat_out" ]] && printf '%s' "$chat_out" | jq -e '(.decision // "") == "block"' >/dev/null 2>&1; then
    chat_ok=no
  fi
  printf '%s' "$chat_out" | grep -q 'transcript unchanged' && chat_ok=no
  chat_detail="$chat_detail mode=$chat_mode:$(printf '%.60s' "$chat_out")"
  rm -rf "$R"
done
if [[ "$chat_ok" == "yes" ]]; then
  pass=$((pass + 1)); printf '  PASS  %s\n' "chat turn → allow via triage in soft AND hard"
else
  fail=$((fail + 1)); printf '  FAIL  %s (%s)\n' "chat turn → allow via triage in soft AND hard" "$chat_detail"
fi

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
