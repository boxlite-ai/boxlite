#!/usr/bin/env bash
# Stop hook: gate the end of a turn on an audited verdict
# (see .claude/agents/verdict-auditor.md).
#
# DETECTION-TRIGGERED, finding-driven loops only. The trigger is the WHOLE FINAL
# TURN — every assistant text since the last real user message, read deterministically
# from the transcript: if it states facts, findings, or outcomes that should be
# double-checked ("root cause is X", "tests pass", investigation conclusions), the
# turn must end with a fresh dossier (.agents/state/last-verdict.json, written by the
# verdict-auditor subagent). Chat, questions, and in-progress narration end freely.
# Turn-level, not last-fragment: findings asserted mid-turn cannot hide behind a
# closing "let me check X" (that miss shipped once, caught by a sibling session's
# decision log).
#
# Flow:
#   1. Dossier present, binding fresh + matching:
#        PASS         -> allow (consumed)
#        IN_PROGRESS  -> allow with note (consumed)
#        FAIL         -> block with the findings — THE one legitimate loop: it
#                        persists until the findings are addressed and a re-audit
#                        passes. A loop driven by real findings is the point.
#   1b. No dossier, but run-verdict-audit.sh is RUNNING — audit_in_flight() decides,
#        on the lock's presence, its PID's liveness AND its freshness bound:
#        allow — the answer is being computed and no amount of re-blocking speeds it
#        up. Its verdict gates the NEXT turn end.
#   2. Dossier present but stale / mismatched (branch, HEAD, tree, age):
#        DISCARD it and fall through to detection. Never block on bookkeeping —
#        "the binding moved" is not a finding, and blocking on it was the
#        meaningless-loop class (e.g. a commit moving HEAD out from under a
#        dossier written seconds earlier).
#   3. No dossier: TRIAGE the turn text through a three-tier cascade, cheapest first,
#      so the 5-10s model round-trip is spent only where it actually decides anything:
#        A. harness noise (0ms)  — the assistant slot holds only text the HARNESS
#           wrote (API errors, quota notices, interruption markers). No model produced
#           it, so it cannot be a claim -> allow. 14.4% of real turns.
#        B. assertion-only (0ms) — a high-precision SUBSET of the fallback list below,
#           limited to forms that report an observation ("173/173 tests pass", a
#           whole-line "done.", a line-initial "Verified …") -> block. 10.7% of turns.
#        C. the model (5-10s)    — everything else. "Does it state facts, findings, or
#           outcomes that should be double-checked before anyone relies on them?" A
#           fast model (haiku) answers YES/NO; when no model is reachable the static
#           pattern list below decides (deterministic fallback, e.g. sessions without
#           a model CLI). YES -> block with the audit instruction; NO -> allow
#           (announced to the human via systemMessage, invisible to the model).
#      No transcript (absent / unreadable / zero bytes) -> allow; nothing to judge.
#      A transcript WITH content but no assistant text is NOT that case — the hook
#      could not SEE the turn (unflushed final message, or a torn write jq could not
#      parse). It waits up to 2s for the text, then fails open under a `blind-allow`
#      rung so the log distinguishes "quiet session" from "gate never looked".
#
#      Tiers A and B are latency work ONLY — neither loosens the gate. A stays sound by
#      requiring EVERY non-empty line to be harness text, so a turn that errored and
#      retried still reaches B/C. B stays sound by leaving every prose-ambiguous
#      phrasing ("tests pass", "root cause is", "deploy is healthy") to the model:
#      removing the static false positives is the whole reason the model is primary,
#      and a turn merely DISCUSSING verdict phrasing must still be allowed.
#   4. Flush-race guard: the harness can fire Stop before appending the turn's final
#      message, leaving the PREVIOUS (already-gated) message last in the transcript.
#      The hook records the uuid it judged; if the newest uuid equals it, the hook
#      waits briefly for the fresh message and, failing that, allows — a message is
#      never judged twice.
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * Triage is the auditor's applicability judgment, extracted: the full verdict-auditor
#   already begins by deciding whether the message asserts anything verifiable. The
#   hook runs that ONE question on a small fast model (~seconds, message-only context)
#   so the expensive audit is spawned only when the answer is YES. Any classifier
#   failure — CLI absent, timeout, garbage output — degrades to the static pattern
#   list, and a pattern miss degrades further to the agent's CLAUDE.md duty: every
#   failure moves toward #915's honor system, never toward a trap. A false positive
#   costs ONE synchronous audit that trivially PASSes — a tax, not a loop. Code spans
#   and fenced blocks are stripped before triage so documentation ABOUT verdicts does
#   not trigger. VERDICT_CLASSIFIER_CMD overrides the classifier (tests use stubs;
#   set it to `false` to force the regex path).
#
# * KNOWN TRAP, unfixed: "never toward a trap" covers CLASSIFIER failure only. When the
#   AUDITOR is unreachable, run-verdict-audit.sh exits 1 with no dossier and no rung
#   tells that apart from "no audit attempted", so the turn cannot end until the API
#   recovers. Needs the runner to signal unavailability.
#
# * Why no loop can form: validation runs BEFORE detection, binding mismatches discard,
#   and audit_in_flight() allows while the bash runner works. FAIL-with-findings is the
#   only repeating block, which is the requirement. A Task-launched auditor leaves no
#   process to observe and so still re-blocks. Do NOT re-derive this from "the audit is
#   synchronous" — that instructs the model, and the harness ignores it.
#
# * Tree-hash binding: at stop time the work is usually UNCOMMITTED (HEAD has not
#   moved), so HEAD alone can't tell "audited" from "changed since audit". The dossier
#   binds to a content-addressed hash of the full working tree via a throwaway index +
#   `git write-tree` (deterministic; no timestamps; never touches the real index). The
#   verdict-auditor computes it the SAME way. On mismatch the dossier is discarded and
#   the CURRENT message re-detected — so a real verdict still demands a fresh audit,
#   while a chat ending after the tree moved is not trapped.
#
# * One-shot consumption: the dossier is `rm -f`'d on every exit path except a
#   fresh+matching FAIL (kept so the finding-driven block persists across attempts
#   to end without addressing it).
#
# * Soft mode is NOT enforcement: the Stop hook's systemMessage is shown to the HUMAN
#   only — the model never sees it (documented hook contract; only a block's `reason`
#   reaches the model). Soft mode exists as telemetry / emergency rollback (flip
#   VERDICT_GATE_HARD_BLOCK=0 in settings env; it propagates mid-session). Default: hard.
#
# Threat model & accepted limitations (this gate catches HONEST mistakes, not a malicious
# parent — the parent and the auditor share one filesystem + toolset):
#   - NOT forge-resistant: the parent can write the dossier itself. Real tamper-evidence
#     needs a signer the parent cannot impersonate (a harness-level capability) — a shell
#     hook cannot provide it. Out of scope by design.
#   - NOT evasion-resistant: a verdict worded outside the pattern list is not detected.
#     The patterns are a curated, tunable list (below) targeting how claims are actually
#     phrased; misses degrade to #915's self-declared behavior, never to a trap.
#
# Tests: bash .agents/hooks/preflight-verdict-check.test.sh
set -uo pipefail

file_mtime_epoch() {
  local path="$1" mtime
  if mtime="$(stat -c '%Y' "$path" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then
    printf '%s' "$mtime"
    return
  fi
  if mtime="$(stat -f '%m' "$path" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then
    printf '%s' "$mtime"
    return
  fi
  printf '0'
}

payload="$(cat)"
transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // ""' 2>/dev/null || echo '')"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
verdict_file="$project_dir/.agents/state/last-verdict.json"
# A FAILed dossier is parked here when the agent's fix moves the tree and invalidates
# the binding, so the next audit re-checks known findings instead of starting cold.
prev_verdict_file="$project_dir/.agents/state/last-verdict.prev.json"
last_uuid_file="$project_dir/.agents/state/verdict-last-uuid"
decision_log="$project_dir/.agents/state/verdict-decisions.log"
# Held by run-verdict-audit.sh while it runs; body format defined by its
# take_audit_lock(). Tells "the agent ignored the findings" from "the answer is coming".
audit_lock_file="$project_dir/.agents/state/verdict-audit.lock"
# Ceiling on a lock's self-declared deadline. NOT max_age_seconds — dossier staleness
# and "how long may an audit run" are different questions.
audit_lock_max_seconds=3600
max_age_seconds=600
classifier_timeout_seconds=20

# One line per Stop decision (gitignored): timestamp, message identity, deciding
# rung, outcome — so "why did/didn't the gate fire?" is answerable with tail
# instead of fixture reconstruction. Best-effort: logging must never fail the
# hook. Rotated in place to stay bounded.
log_decision() {  # rung outcome
  { mkdir -p "$(dirname "$decision_log")"
    printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FINAL_ID:--}" "$1" "$2" >> "$decision_log"
    if [[ "$(wc -l < "$decision_log")" -gt 1000 ]]; then
      tail -n 500 "$decision_log" > "$decision_log.tmp" && mv "$decision_log.tmp" "$decision_log"
    fi
  } 2>/dev/null || true
}

allow()           { exit 0; }                                              # let the turn end, silently
# User-visible, model-invisible allow: a Stop hook systemMessage is shown to the
# HUMAN in the terminal only — the model never sees it (documented hook contract).
# Announcing triage results this way keeps the agent's context clean and the gate
# loop-inert while the human still sees every decision live.
allow_with_note() { jq -nc --arg m "$1" '{continue:true, systemMessage:$m}'; exit 0; }
# Hard mode (default, set in settings.json env): block conditions block. Soft mode
# (VERDICT_GATE_HARD_BLOCK=0) demotes them to a user-visible nudge the MODEL never
# sees — rollback/telemetry only, see design notes.
block() {
  # Default HARD, matching the two doc sites above. Defaulting to soft meant only
  # Claude Code was gated: it is the sole caller that sets this, via settings.json
  # env, so the Codex registration in .codex/hooks.json and any direct invocation
  # got a non-blocking note instead. Set VERDICT_GATE_HARD_BLOCK=0 to roll back.
  if [[ "${VERDICT_GATE_HARD_BLOCK:-1}" != "0" ]]; then
    jq -nc --arg r "$1" '{decision:"block", reason:$r}'
  else
    jq -nc --arg r "$1" '{continue:true, systemMessage:("[verdict-gate] " + $r)}'
  fi
  exit 0
}

# Content-addressed hash of the full working tree (tracked + untracked, full
# content), via a throwaway index. Deterministic and read-only w.r.t. the real
# index/tree. Keep IDENTICAL to the snippet in verdict-auditor.md.
compute_tree_hash() {
  local idx; idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$repo_root" read-tree HEAD >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" write-tree 2>/dev/null
  rm -f "$idx"
}

# ALL assistant text of the FINAL TURN — every text block emitted since the last
# real user message — from the session transcript (JSONL). Turn-level, not
# last-fragment: a finding asserted mid-turn ("no auto-start in the proxy")
# followed by closing narration ("let me check X") must still reach triage;
# judging only the trailing fragment let exactly that class slip (observed live
# in a sibling session's decision log).
#
# HARNESS-AGNOSTIC by convention, not by schema list: an assistant record is one
# where ANY object inside has role/type=="assistant"; a REAL user record (turn
# boundary) is one with role/type=="user" carrying actual text — tool results
# riding user-role records do not end a turn. Text is every string under a
# `text` key inside blocks whose type mentions "text" (Claude Code `text`,
# Codex `output_text`, any future agent following the conventions), falling
# back to all `text`-key strings if that yields nothing. New coding agents need
# ZERO code here — at most set VERDICT_EXTRACTOR_CMD in their own hook wiring
# for a truly alien format (invoked with the transcript path as $1; stdout =
# the turn text to judge).
# Turn identity is a checksum of the joined text — content-derived, no
# per-harness ids — used by the never-judge-twice race guard.
# Empty text (no/unreadable transcript) means detection cannot run → the caller
# falls back to allow (fail-open, never trap on absent state).
FINAL_ID=""
FINAL_TEXT=""
extract_final_message() {
  FINAL_ID=""; FINAL_TEXT=""
  [[ -n "$transcript_path" && -r "$transcript_path" ]] || return 0
  if [[ -n "${VERDICT_EXTRACTOR_CMD:-}" ]]; then
    FINAL_TEXT="$(bash -c "$VERDICT_EXTRACTOR_CMD \"\$1\"" _ "$transcript_path" 2>/dev/null || true)"
  else
    FINAL_TEXT="$(jq -rs '
      def is_assistant: [.. | objects | select((.role? == "assistant") or (.type? == "assistant"))] | length > 0;
      def is_real_user:
        # A REAL user record carries a text-typed block at the TOP LEVEL of the
        # role-object own content (or plain string content). Tool results ride
        # user-role records with text nested INSIDE a tool_result block —
        # recursing into them (an earlier version did) turned every Read/Agent/
        # MCP result into a fake turn boundary and mid-turn findings escaped.
        ((.type? == "user") and
          ((.message.content? | type) == "string"
           or ([.message.content[]? | select((.type? // "") == "text")] | length) > 0))
        or ([.. | objects | select((.role? // "") == "user")
             | [.content[]? | select((.type? // "" | tostring) | test("text"))] | length]
            | any(. > 0));
      . as $r
      | ([$r[] | is_real_user] | rindex(true)) as $lastu
      | $r[(if $lastu == null then 0 else $lastu + 1 end):]
      | [.[] | select(is_assistant) | (
          ([.. | objects | select((.type? // "" | tostring) | test("text")) | .text? // empty | strings] | join("\n")) as $typed
          | (if ($typed | length) > 0 then $typed
             else ([.. | objects | .text? // empty | strings] | join("\n")) end)
        ) | select(length > 0)]
      | join("\n\n")' "$transcript_path" 2>/dev/null || true)"
  fi
  [[ -n "$FINAL_TEXT" ]] || return 0
  FINAL_ID="cksum-$(printf '%s' "$FINAL_TEXT" | cksum | tr ' \t' '--')"
}

# Remove fenced code blocks and inline code spans: verdict phrasing inside code is
# documentation about claims, not a claim.
strip_code() {
  awk 'BEGIN{fence=0} /^[[:space:]]*```/{fence=!fence; next} !fence' | sed -E 's/`[^`]*`//g'
}

# ── Tier A: harness text sitting in the assistant slot ───────────────────────
# The assistant slot also carries text the HARNESS wrote, not the model: API errors,
# quota notices, interruption markers. It asserts nothing — no model produced it — so
# it can never be a verdict, and spending a 5-10s model round-trip to learn that is
# pure latency. Measured on this repo's transcripts: 81 of 563 real turns (14.4%) are
# exactly this, led by "API Error: 400 Your input exceeds the context window" (x43)
# and "No response requested." (x15).
#
# EVERY non-empty line must match — that is the soundness property, and it is why
# this is not a heuristic about content. Anchoring only the FIRST line would leak a
# real verdict whenever the model hit a transient error and then retried inside the
# same turn ("API Error: Overloaded" followed by "Root cause is X. All 53 tests
# pass."). Both variants catch the same 81 turns, so the strict one costs nothing.
harness_patterns='^[[:space:]]*(API Error'
harness_patterns+='|No response requested\.'
harness_patterns+='|Your organization has disabled'
harness_patterns+="|You've hit your (weekly|usage) limit"
harness_patterns+='|Credit balance is too low'
harness_patterns+='|Claude Code is unable'
harness_patterns+='|\[?Request (was )?(aborted|interrupted)'
harness_patterns+=')'
is_harness_noise() {  # $1 = stripped turn text
  local total matched
  total="$(printf '%s\n' "$1" | grep -c '[^[:space:]]' 2>/dev/null || true)"
  [[ "${total:-0}" -gt 0 ]] || return 1
  matched="$(printf '%s\n' "$1" | grep -Eic "$harness_patterns" 2>/dev/null || true)"
  [[ "${matched:-0}" -eq "$total" ]]
}

# ── Tier B: assertion-only claims, decidable without the model ───────────────
# A deliberately SMALL subset of the fallback list below: forms that REPORT an
# observation rather than name one — a concrete count ("173/173 tests pass"), a
# whole-line "done.", a line-initial "Verified …". Prose that merely DISCUSSES
# verdict phrasing ("people write things like tests pass or root cause is X") cannot
# take these shapes, so promoting them ahead of the classifier does not resurrect the
# static false positives the classifier exists to remove — which is why the ambiguous
# majority ("tests pass", "root cause is", "deploy is healthy") stays with the model.
# "deploy is healthy" is in the ambiguous group on purpose: "once the deploy is
# healthy, we proceed" is discussion, not a claim.
# Measured: 60/563 turns (10.7%), zero false blocks across 21 model-labelled hits.
assertion_patterns='[0-9]+ */ *[0-9]+ +(tests?|checks?|suites?|cases?)? *(pass(ed|ing|es)?|green)'
assertion_patterns+='|^[[:space:]]*done[.! ]*$'
assertion_patterns+='|^[[:space:]]*(verified|confirmed)[[:space:]]+[a-z]'

# Triage: ask a small fast model whether the turn states facts, findings, or
# outcomes that should be double-checked before anyone relies on them.
# Echoes YES / NO / UNKNOWN. UNKNOWN (no CLI, timeout, garbage) → regex fallback.
# VERDICT_CLASSIFIER_CMD overrides the whole classifier invocation (stdin = turn
# text, stdout = YES/NO); tests stub it, `false` forces UNKNOWN.
triage_prompt='The assistant text of a just-ended turn follows. Decide one thing:
does it state facts, findings, or outcomes as established that should be
double-checked before anyone relies on them? If yes, answer YES — an independent
audit will verify them. If there is nothing to check, answer NO.
Reply with exactly one word: YES or NO.'
should_audit() {  # stdin-less; uses $1 as the stripped message; echoes YES/NO/UNKNOWN
  local msg="$1" out=""
  if [[ -n "${VERDICT_CLASSIFIER_CMD:-}" ]]; then
    out="$(printf '%s' "$msg" | bash -c "$VERDICT_CLASSIFIER_CMD" 2>/dev/null | tail -n1 | tr -dc 'A-Za-z' | tr '[:lower:]' '[:upper:]')"
  elif command -v claude >/dev/null 2>&1; then
    # perl alarm = portable timeout (macOS has no coreutils `timeout`).
    # disableAllHooks guards nested-hook recursion from inside a hook.
    out="$(printf '%s\n\n<message>\n%s\n</message>\n' "$triage_prompt" "$msg" \
      | perl -e 'alarm shift; exec @ARGV' "$classifier_timeout_seconds" \
          claude -p --model claude-haiku-4-5-20251001 --settings '{"disableAllHooks":true}' 2>/dev/null \
      | tail -n1 | tr -dc 'A-Za-z' | tr '[:lower:]' '[:upper:]')"
  fi
  case "$out" in
    YES) echo YES ;;
    NO)  echo NO ;;
    *)   echo UNKNOWN ;;
  esac
}

# Fallback claim patterns (ERE, matched case-insensitively) for when the classifier
# is unreachable. Targets how verdicts are actually phrased; tune here. A miss
# degrades to self-declared, a spurious hit costs one trivial-PASS audit.
verdict_patterns='root cause (is|was|confirmed|:)'
verdict_patterns+='|(all |the )?(tests?|suites?|checks?|builds?) (now |all |still )?(pass(es|ed|ing)?|green)'
verdict_patterns+='|[0-9]+/[0-9]+ (tests? )?(pass|passing|green)'
verdict_patterns+='|no (issues|bugs|problems|errors|regressions)'
verdict_patterns+='|(is|are|looks?) (now )?(fixed|resolved|working|correct|healthy|stable|live|green|complete|done|verified)'
verdict_patterns+='|works (as expected|correctly|now|fine|end.to.end)'
verdict_patterns+='|(fix|change|patch|refactor|migration) (works|is in place)'
verdict_patterns+='|(verified|confirmed)([;,.!]| that| the| it| locally| e2e| end)'
verdict_patterns+='|^[[:space:]]*(verified|confirmed) [a-z]'
verdict_patterns+='|deploy(ment|ed)? (is |looks? )?(healthy|live|successful|stable)'
verdict_patterns+='|^[[:space:]]*done[.! ]*$'
# Chinese claim phrasings (conservative set — the classifier handles languages the
# list never will; these keep the FALLBACK useful in bilingual sessions).
verdict_patterns+='|根因(是|为|：|:)'
verdict_patterns+='|(测试|用例)(全部|都|均)?(通过|绿)'
verdict_patterns+='|没有(问题|异常|回归)'
verdict_patterns+='|已(修复|解决|完成|验证)'
verdict_patterns+='|(部署|服务|线上)(正常|健康|稳定)'

# ── Shared re-audit instruction (used by every block path) ───────────────────
# The block `reason`s below are the gate's UX + anti-cheating contract — what Claude
# reads when a verdict is detected unaudited, or a declared verdict FAILed. Invariants:
#   • Direct Claude to invoke the verdict-auditor subagent SYNCHRONOUSLY (Task with
#     run_in_background: false) — a background audit's completion event is what
#     created the #892 loop; a synchronous audit keeps audit and verdict in one turn.
#   • The AUDITOR — not Claude — writes ${verdict_file}. Claude must not write or
#     hand-edit the dossier (that is grading its own homework / confabulating proof).
#   • Offer the honest exits: IN_PROGRESS if not actually done; a `blocked` proof
#     entry (with residual risk) if proof genuinely can't be produced in this env.
#   • After the auditor reports, end the turn again; this hook re-checks.
#
#   • When a prior audit FAILED on this same work, hand its findings to the auditor so
#     round N+1 re-checks them against the delta instead of re-deriving every claim
#     from cold. A function, not a string, so the prior-dossier note reflects state as
#     it is at BLOCK time rather than at definition time.
#
# Variables available: ${transcript_path} ${branch} ${head} ${verdict_file}
verdict_instruction() {
  local prior=""
  [[ -r "$prev_verdict_file" ]] && prior="

A PRIOR audit of this same work FAILED; its findings are in ${prev_verdict_file}.
Re-check THOSE findings against what changed and carry forward the proof entries
whose evidence still holds, rather than re-deriving every claim from scratch. Still
read the WHOLE turn — narrowing applies to re-verification only, never to finding
claims, so anything the fix newly asserts is still caught."
  cat <<EOF
Audit before ending — run the audit SYNCHRONOUSLY (the dossier
must exist before you end), via WHICHEVER of these your harness supports:

Claude Code:
  Task(subagent_type='verdict-auditor',
       description='verdict proof check',
       prompt='Audit my final turn — every assistant message since the last real user
               message: each claim it presents as established, mid-turn or closing, must have
               concrete, direct proof in the evidence — the working-tree diff, the
               commands and their output in the transcript, or cited files/logs. A claim
               backed only by guessing or indirect inference is NOT proven. A turn that
               asserts nothing verifiable is a PASS. transcript_path: ${transcript_path}')
       (run_in_background: false)

Any other agent (no Task tool):
  bash .agents/hooks/run-verdict-audit.sh '${transcript_path}'

The AUDITOR — not you — writes ${verdict_file}; do not write it yourself. If you are
pausing or asking the user something, have it record IN_PROGRESS with what remains;
if a claim genuinely cannot be proven here, it can mark that proof 'blocked' with the
residual risk. Then end your turn again.${prior}
EOF
}
# ─────────────────────────────────────────────────────────────────────────────

# A parked FAIL is only useful to the NEXT audit of the SAME round. If nobody ever
# claimed it — the round was abandoned, the user changed topic, no re-audit ran — it must
# not be handed to an auditor judging unrelated work. That is the identical hazard the
# park-side age gate closes, one site over: gating only the write bounds staleness at
# park time, while this file is read on every later block. Left unexpired it manufactures
# findings about dead work, and since the auditor is told "a finding you cannot confirm as
# addressed stays a finding", those become a FAIL — re-entering the meaningless-loop class
# item 2 of this header exists to eliminate.
expire_stale_prev() {
  [[ -r "$prev_verdict_file" ]] || return 0
  local parked_age=$(( $(date +%s) - $(file_mtime_epoch "$prev_verdict_file") ))
  (( parked_age > max_age_seconds )) && rm -f "$prev_verdict_file"
  return 0
}
expire_stale_prev

# ── Present dossier → validate the binding, then the verdict decides ─────────
if [[ -r "$verdict_file" ]]; then
  v_branch="$(jq -r '.branch // ""'    "$verdict_file" 2>/dev/null || echo '')"
  v_head="$(jq -r '.head // ""'        "$verdict_file" 2>/dev/null || echo '')"
  v_tree="$(jq -r '.tree_hash // ""'   "$verdict_file" 2>/dev/null || echo '')"
  v_verdict="$(jq -r '.verdict // ""'  "$verdict_file" 2>/dev/null || echo '')"

  # Keep failed platform probes from contaminating the successful command's output.
  v_mtime="$(file_mtime_epoch "$verdict_file")"
  now_epoch="$(date +%s)"
  age=$(( now_epoch - v_mtime ))

  cur_tree="$(compute_tree_hash)"

  if [[ "$v_branch" != "$branch" ]] || \
     [[ "$v_head" != "$head" ]] || \
     [[ "$v_tree" != "$cur_tree" ]] || \
     (( age > max_age_seconds )); then
    # Bookkeeping mismatch (branch/HEAD/tree moved, or dossier aged out) → discard
    # and fall through to detection. The current turn's OWN text decides
    # below whether a FRESH audit is demanded; the mismatch itself never blocks.
    log_decision dossier discard-stale
    # A FAILed dossier is the one worth keeping across the discard: the binding almost
    # always moved because the agent was FIXING those findings, and the observed cycle
    # (FAIL-block -> fix -> discard-stale -> re-detect -> block) then paid a full COLD
    # re-audit every round. Parking it lets round N+1 re-check known findings against
    # the delta. PASS/IN_PROGRESS that merely aged out carry nothing to re-check.
    # ...but ONLY while it is still fresh. The discard fires for four reasons, and just
    # one of them means a round is in flight: the tree moved because the agent was
    # fixing these findings. An AGE-OUT means the opposite — nobody acted on them and
    # the round is over, so parking it hands the next audit findings about unrelated
    # work. Observed live: a FAIL from 04:46 was still being parked at 05:37 and
    # offered to an auditor judging a different task entirely.
    if [[ "$v_verdict" == "FAIL" ]] && (( age <= max_age_seconds )); then
      # `touch` after the move on purpose: mv preserves the ORIGINAL write time, but the
      # read side needs to know how long this has sat unclaimed, not how old the verdict
      # was. Parking is the event that starts that clock.
      mv -f "$verdict_file" "$prev_verdict_file" 2>/dev/null && touch "$prev_verdict_file" \
        || rm -f "$verdict_file"
    else
      rm -f "$verdict_file"
    fi
  else
    case "$v_verdict" in
      PASS)
        log_decision dossier PASS-allow
        # The parked FAIL goes too: the cycle it belonged to just ended clean, and a
        # surviving prev would point the next audit at findings already resolved.
        rm -f "$verdict_file" "$prev_verdict_file"   # consume; the next verdict re-audits
        allow_with_note "[verdict-gate] dossier PASS → consumed, turn ends"
        ;;
      IN_PROGRESS)
        remaining="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
        log_decision dossier IN_PROGRESS-allow
        rm -f "$verdict_file" "$prev_verdict_file"
        allow_with_note "Verdict: IN_PROGRESS — proof deferred, work not yet complete:
${remaining}"
        ;;
      *)
        log_decision dossier FAIL-block
        # FAIL (or unexpected): the finding-driven block. The dossier is KEPT so
        # ending again without addressing the findings re-blocks — this is the one
        # loop the gate is ALLOWED to have. A fix that changes the tree invalidates
        # the binding above and routes through a fresh detection instead.
        findings="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
        block "Verdict proof check FAILED on branch '${branch}':

${findings}

Address each finding, then re-audit. This block persists until a re-audit passes.
$(verdict_instruction)"
        ;;
    esac
  fi
fi

# ── An audit is RUNNING and has not answered yet → allow, don't busy-wait ────
# Level-triggered gate, edge-triggered remedy: an audit takes minutes, a re-block cycle
# ~3s, so without this rung the agent is re-blocked for the whole duration of the fix
# the gate demanded. Observed: 108 blocks in one session, 39 in a 512s window.
# Only the bash runner takes the lock; a Task-launched auditor leaves nothing to observe
# and keeps today's behaviour.
audit_in_flight() {
  # Dossier absence is the runner's own proof it has not answered (it removes the file
  # before auditing). Redundant with the call site below the dossier branch, kept so the
  # predicate survives being hoisted.
  [[ -r "$audit_lock_file" && ! -e "$verdict_file" ]] || return 1
  local body pid deadline lock_mtime now
  body="$(cat "$audit_lock_file" 2>/dev/null || echo '')"
  # Here-string, not `read < file`: the body has no trailing newline, so `read` assigns
  # and still exits 1 at EOF, which with `|| return 1` silently disables this rung.
  read -r pid deadline <<< "$body"
  # `0` excluded: `kill -0 0` signals the caller's own process group and succeeds, so a
  # truncated write would buy a blanket allow. $$ is never 0.
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  # A lock file alone proves nothing: the trap misses SIGKILL, orphaning the lock.
  kill -0 "$pid" 2>/dev/null || return 1
  lock_mtime="$(file_mtime_epoch "$audit_lock_file")"
  now="$(date +%s)"
  # Only the runner knows VERDICT_AUDITOR_TIMEOUT, so it writes the deadline; bounding
  # by max_age_seconds (dossier staleness) would expire the lock mid-run. Past the
  # ceiling is rejected, not capped — that lock is not what we think it is.
  if [[ "$deadline" =~ ^[1-9][0-9]*$ ]]; then
    (( now <= deadline && deadline <= lock_mtime + audit_lock_max_seconds ))
  else
    # No deadline field: a lock from an older runner, or a torn write. Fall back to the
    # conservative bound rather than trusting an unbounded lock.
    (( now - lock_mtime <= max_age_seconds ))
  fi
}
if audit_in_flight; then
  log_decision audit inflight-allow
  allow_with_note "[verdict-gate] audit in flight (pid $(cut -d' ' -f1 "$audit_lock_file" 2>/dev/null)) → allow; its verdict gates the next turn"
fi

# ── No (usable) dossier → triage: does the turn assert a verdict? ───────────
extract_final_message
# An empty extraction has two very different causes, and collapsing them into one exit
# let real turns end UNJUDGED in silence:
#   * no transcript — absent, unreadable, or zero bytes. Nothing to judge, and no
#     amount of waiting will produce anything -> allow immediately.
#   * a transcript WITH content that yields no assistant text — the hook could not SEE
#     the turn. Either the harness had not flushed this turn's final message yet, or a
#     torn mid-append write left the JSONL briefly unparseable (jq's failure above is
#     swallowed, so it is indistinguishable from "no text"). That is a real turn about
#     to slip past the gate, so give it the SAME bounded wait the identity guard below
#     uses before failing open. Observed live: a turn whose text record landed 0.1s
#     after this hook read the file logged `extract empty-allow` and was never triaged.
if [[ -z "$FINAL_TEXT" && -s "$transcript_path" ]]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.2
    extract_final_message
    [[ -n "$FINAL_TEXT" ]] && break
  done
  # Still blind after the wait: fail open (never trap on absent state), but under a rung
  # that says so. Logging this as `empty` would leave `tail`ing the log unable to tell a
  # quiet session from a gate that never looked, which is how this went unnoticed.
  if [[ -z "$FINAL_TEXT" ]]; then
    log_decision extract blind-allow
    allow_with_note "[verdict-gate] transcript has content but no assistant text after 2s → allowing UNJUDGED"
  fi
fi
if [[ -z "$FINAL_TEXT" ]]; then
  log_decision extract empty-allow
  allow
fi

# Flush-race guard: if the newest transcript message is the one already judged, the
# harness fired Stop before appending this turn's final text. Wait briefly for the
# fresh message; if none arrives there is nothing new to judge → allow. A message
# is never judged twice.
recorded_id="$(cat "$last_uuid_file" 2>/dev/null || echo '')"
if [[ -n "$FINAL_ID" && -n "$recorded_id" && "$FINAL_ID" == "$recorded_id" ]]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.2
    extract_final_message
    [[ "$FINAL_ID" != "$recorded_id" ]] && break
  done
  if [[ -z "$FINAL_TEXT" || "$FINAL_ID" == "$recorded_id" ]]; then
    log_decision race stale-allow
    allow_with_note "[verdict-gate] transcript unchanged since last judgment → allow"
  fi
fi

stripped="$(printf '%s\n' "$FINAL_TEXT" | strip_code)"
mkdir -p "$(dirname "$last_uuid_file")" 2>/dev/null || true
printf '%s' "$FINAL_ID" > "$last_uuid_file" 2>/dev/null || true   # judged now, allow or block

# ── Tier A (0ms): harness text asserts nothing → allow without a model call ──
# Placed AFTER the identity write so this allow path records what it judged, exactly
# like every other one.
if is_harness_noise "$stripped"; then
  log_decision harness noise-allow
  allow_with_note "[verdict-gate] harness/API text only, no assistant claim → allow"
fi

# ── Tier B (0ms): assertion-only claim → block without a model call ──────────
# Only the forms that report an observation (see assertion_patterns). Everything the
# classifier is better at judging falls through to tier C untouched.
asserted="$(printf '%s\n' "$stripped" | grep -Eio "$assertion_patterns" 2>/dev/null | head -n1 || true)"
if [[ -n "$asserted" ]]; then
  log_decision assertion match-block
  block "This turn asserts a verdict (\"${asserted}\") but no audited
dossier backs it. A claim stated as established needs proof attached.
$(verdict_instruction)"
fi

triage="$(should_audit "$stripped")"
if [[ "$triage" == "NO" ]]; then
  log_decision triage NO-allow
  allow_with_note "[verdict-gate] triage: NO — nothing to double-check → allow"
fi
if [[ "$triage" == "YES" ]]; then
  log_decision triage YES-block
  block "This turn asserts a verdict (triage: YES) but no audited
dossier backs it. A claim stated as established needs proof attached.
$(verdict_instruction)"
fi

# Triage UNKNOWN (no model reachable) → deterministic pattern fallback.
matched="$(printf '%s\n' "$stripped" | grep -Eio "$verdict_patterns" 2>/dev/null | head -n1 || true)"
if [[ -z "$matched" ]]; then
  log_decision regex none-allow
  allow_with_note "[verdict-gate] triage unavailable, fallback patterns: no match → allow"
fi

log_decision regex match-block
block "This turn asserts a verdict (matched: \"${matched}\") but no audited
dossier backs it. A claim stated as established needs proof attached.
$(verdict_instruction)"
