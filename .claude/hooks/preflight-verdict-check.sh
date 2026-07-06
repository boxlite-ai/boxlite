#!/usr/bin/env bash
# Stop hook: gate the end of a turn on an audited verdict
# (see .claude/agents/verdict-auditor.md).
#
# DETECTION-TRIGGERED, finding-driven loops only. The trigger is the turn's FINAL
# ASSISTANT MESSAGE, read deterministically from the transcript (no model call): if it
# asserts a verdict — "root cause is X", "tests pass", "prod looks healthy", "done" —
# the turn must end with a fresh dossier (.claude/.last-verdict.json, written by the
# verdict-auditor subagent). Chat, questions, and neutral discussion end freely. This
# covers file-less verdicts (pure investigation / ops findings), which the delta design
# it replaces could not see.
#
# Flow:
#   1. Dossier present, binding fresh + matching:
#        PASS         -> allow (consumed)
#        IN_PROGRESS  -> allow with note (consumed)
#        FAIL         -> block with the findings — THE one legitimate loop: it
#                        persists until the findings are addressed and a re-audit
#                        passes. A loop driven by real findings is the point.
#   2. Dossier present but stale / mismatched (branch, HEAD, tree, age):
#        DISCARD it and fall through to detection. Never block on bookkeeping —
#        "the binding moved" is not a finding, and blocking on it was the
#        meaningless-loop class (e.g. a commit moving HEAD out from under a
#        dossier written seconds earlier).
#   3. No dossier: detect. Verdict-shaped final message -> block with the audit
#      instruction; anything else -> allow. No transcript / no text -> allow.
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * Why prose detection is safe HERE: false negatives (a creatively-worded verdict) are
#   accepted — the threat model is honest mistakes, and an unmatched verdict just falls
#   back to the agent's CLAUDE.md duty. A false positive costs ONE synchronous audit
#   that trivially PASSes ("turn asserts nothing verifiable") — a tax, not a loop.
#   Code spans and fenced blocks are stripped before matching so documentation ABOUT
#   verdicts does not trigger (a session discussing this very gate stays quiet).
#
# * Why no loop can form: the audit is mandated SYNCHRONOUS (the block instruction
#   says run_in_background: false), so audit and verdict share one turn — there is no
#   completion event to re-open anything (#892's default-deny looped precisely on
#   async audit completions). Validation runs BEFORE detection, so the re-ended turn
#   consumes its fresh dossier and never reaches the detector. Binding mismatches
#   discard instead of blocking. The only repeating block is FAIL-with-findings,
#   which is requirement, not bug; the harness's 8-consecutive-block cap backstops.
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
# Tests: bash .claude/hooks/preflight-verdict-check.test.sh
set -uo pipefail

payload="$(cat)"
transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // ""' 2>/dev/null || echo '')"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
verdict_file="$project_dir/.claude/.last-verdict.json"
max_age_seconds=600

allow()           { exit 0; }                                              # let the turn end
allow_with_note() { jq -nc --arg m "$1" '{continue:true, systemMessage:$m}'; exit 0; }
# Hard mode (default, set in settings.json env): block conditions block. Soft mode
# (VERDICT_GATE_HARD_BLOCK=0) demotes them to a user-visible nudge the MODEL never
# sees — rollback/telemetry only, see design notes.
block() {
  if [[ "${VERDICT_GATE_HARD_BLOCK:-0}" == "1" ]]; then
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

# Last assistant message with text content, from the session transcript (JSONL).
# Empty output (no/unreadable transcript, no text) means detection cannot run →
# the caller falls back to allow (fail-open, never trap on absent state).
extract_final_message() {
  [[ -n "$transcript_path" && -r "$transcript_path" ]] || return 0
  jq -rs '[.[] | select(.type=="assistant") | .message.content
           | if type=="array" then (map(select(.type=="text") | .text) | join("\n")) else tostring end
           | select(length>0)] | last // ""' "$transcript_path" 2>/dev/null || true
}

# Remove fenced code blocks and inline code spans: verdict phrasing inside code is
# documentation about claims, not a claim.
strip_code() {
  awk 'BEGIN{fence=0} /^[[:space:]]*```/{fence=!fence; next} !fence' | sed -E 's/`[^`]*`//g'
}

# Curated claim patterns (ERE, matched case-insensitively). Targets how verdicts are
# actually phrased; tune here. A miss degrades to self-declared, a spurious hit costs
# one trivial-PASS audit.
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
# Variables available: ${transcript_path} ${branch} ${head} ${verdict_file}
verdict_instruction="Audit before ending: invoke the verdict-auditor subagent
SYNCHRONOUSLY (run_in_background: false — the dossier must exist before you end).
  Task(subagent_type='verdict-auditor',
       description='verdict proof check',
       prompt='Audit my last message: each claim it presents as established must have
               concrete, direct proof in the evidence — the working-tree diff, the
               commands and their output in the transcript, or cited files/logs. A claim
               backed only by guessing or indirect inference is NOT proven. A turn that
               asserts nothing verifiable is a PASS. transcript_path: ${transcript_path}')

The AUDITOR — not you — writes ${verdict_file}; do not write it yourself. If you are
pausing or asking the user something, have it record IN_PROGRESS with what remains;
if a claim genuinely cannot be proven here, it can mark that proof 'blocked' with the
residual risk. Then end your turn again."
# ─────────────────────────────────────────────────────────────────────────────

# ── Present dossier → validate the binding, then the verdict decides ─────────
if [[ -r "$verdict_file" ]]; then
  v_branch="$(jq -r '.branch // ""'    "$verdict_file" 2>/dev/null || echo '')"
  v_head="$(jq -r '.head // ""'        "$verdict_file" 2>/dev/null || echo '')"
  v_tree="$(jq -r '.tree_hash // ""'   "$verdict_file" 2>/dev/null || echo '')"
  v_verdict="$(jq -r '.verdict // ""'  "$verdict_file" 2>/dev/null || echo '')"

  # mtime as freshness signal — portable across BSD (stat -f %m) and GNU (stat -c %Y).
  v_mtime="$(stat -f '%m' "$verdict_file" 2>/dev/null || stat -c '%Y' "$verdict_file" 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  age=$(( now_epoch - v_mtime ))

  cur_tree="$(compute_tree_hash)"

  if [[ "$v_branch" != "$branch" ]] || \
     [[ "$v_head" != "$head" ]] || \
     [[ "$v_tree" != "$cur_tree" ]] || \
     (( age > max_age_seconds )); then
    # Bookkeeping mismatch (branch/HEAD/tree moved, or dossier aged out) → discard
    # and fall through to detection. The current turn's OWN final message decides
    # below whether a FRESH audit is demanded; the mismatch itself never blocks.
    rm -f "$verdict_file"
  else
    case "$v_verdict" in
      PASS)
        rm -f "$verdict_file"   # consume; the next verdict re-audits
        allow
        ;;
      IN_PROGRESS)
        remaining="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
        rm -f "$verdict_file"
        allow_with_note "Verdict: IN_PROGRESS — proof deferred, work not yet complete:
${remaining}"
        ;;
      *)
        # FAIL (or unexpected): the finding-driven block. The dossier is KEPT so
        # ending again without addressing the findings re-blocks — this is the one
        # loop the gate is ALLOWED to have. A fix that changes the tree invalidates
        # the binding above and routes through a fresh detection instead.
        findings="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
        block "Verdict proof check FAILED on branch '${branch}':

${findings}

Address each finding, then re-audit. This block persists until a re-audit passes.
${verdict_instruction}"
        ;;
    esac
  fi
fi

# ── No (usable) dossier → detect: does the final message assert a verdict? ───
final_message="$(extract_final_message)"
[[ -z "$final_message" ]] && allow

matched="$(printf '%s\n' "$final_message" | strip_code | grep -Eio "$verdict_patterns" 2>/dev/null | head -n1 || true)"
[[ -z "$matched" ]] && allow

block "Your final message asserts a verdict (matched: \"${matched}\") but no audited
dossier backs it. A claim stated as established needs proof attached.
${verdict_instruction}"
