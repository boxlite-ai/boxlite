#!/usr/bin/env bash
# Stop hook: gate the end of a turn on an audited verdict
# (see .claude/agents/verdict-auditor.md).
#
# Delta-triggered + self-declared: the hook does NOT parse prose to detect a verdict.
# The trigger is the TURN DELTA — turn-baseline.sh (UserPromptSubmit) snapshots the
# working-tree hash at turn start; if the tree changed by turn end, work happened and
# the turn must end with a fresh dossier (.claude/.last-verdict.json, written by the
# verdict-auditor subagent). A no-delta turn with no dossier ends freely. Verdicts that
# change no files (pure investigation) remain self-declared per CLAUDE.md's Verify rule,
# nudged by the reminder turn-baseline.sh injects while the tree is dirty. This hook
# calls no model and reads no transcript.
#
# Flow:
#   1. turn-baseline.sh records the tree hash at turn start (.claude/.turn-baseline).
#   2. When the agent renders a verdict, it invokes the verdict-auditor subagent, which
#      writes .claude/.last-verdict.json.
#   3. Hook validates: a fresh, matching PASS/IN_PROGRESS dossier -> allow (consumed).
#   4. NO dossier: tree unchanged since turn start (or no/corrupt baseline) -> allow;
#      tree CHANGED -> block with the re-audit instruction.
#   5. A stale / mismatched / FAIL dossier -> block (hard) or nudge (soft).
# After a block the agent re-audits and ends again. The subagent's own completion is a
# SubagentStop event, not Stop, so it does not re-trigger this hook (no recursion).
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * Why the delta, not detection: a Stop hook fires with no "did I render a verdict?"
#   signal. Parsing the message prose is brittle (rejected), and demanding a dossier on
#   EVERY turn (default-deny, #892) loops: each audit's completion re-invokes a turn that
#   then demands another audit. The tree delta keys the demand to evidence of work, which
#   no-op acknowledgment turns never have: dossier and baseline are gitignored, so the
#   gate's own artifacts are never a delta, and audit-completion turns end freely — the
#   audit -> completion -> audit cycle cannot form. Conversational turns over an
#   already-dirty tree are also delta-free (the baseline captured the dirty state at turn
#   start). The harness's 8-consecutive-block cap backstops any residual cycle.
#
# * Missing/corrupt baseline falls back to self-declared (allow on no dossier): the
#   UserPromptSubmit hook may not have run (other harnesses, first turn after adoption),
#   and a gate must not trap on its own absent state.
#
# * Tree-hash binding: at stop time the work is usually UNCOMMITTED (HEAD has not
#   moved), so HEAD alone can't tell "audited" from "changed since audit". We bind
#   the dossier — and the turn-start baseline — to a content-addressed hash of the
#   full working tree, computed via a throwaway index + `git write-tree`
#   (deterministic; no timestamps; never touches the real index). The verdict-auditor
#   and turn-baseline.sh compute it the SAME way. The hash is computed when a dossier
#   or a valid baseline exists; only the bare fallback path does no git tree work.
#
# * Every block is satisfiable by a fresh PASS / IN_PROGRESS dossier, so we never depend
#   on stop_hook_active.
#
# * One-shot consumption: the dossier is `rm -f`'d on the allow path so the next
#   verdict re-audits (a stale PASS can't rubber-stamp a later, different claim).
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
#   - NOT content-bound: the dossier binds to working-TREE state + verdict, not to the
#     turn's specific claims, so one un-consumed PASS can authorize a same-tree turn whose
#     claims differ. Bounded by one-shot consumption; per-message binding is incompatible
#     with the async model (the auditor audits a mid-turn message, not the final one).
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
baseline_file="$project_dir/.claude/.turn-baseline"
max_age_seconds=600

allow()           { exit 0; }                                              # let the turn end
allow_with_note() { jq -nc --arg m "$1" '{continue:true, systemMessage:$m}'; exit 0; }
# Hard mode (default, set in settings.json env): block conditions block. Soft mode
# (VERDICT_GATE_HARD_BLOCK=0) demotes them to a user-visible nudge the MODEL never
# sees — rollback/telemetry only, see design notes. Conversational turns over a dirty
# tree don't need soft mode: they are delta-free and end freely either way.
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
# index/tree. Keep IDENTICAL to the snippets in turn-baseline.sh and
# verdict-auditor.md — a desynced baseline hash reads as a phantom delta.
compute_tree_hash() {
  local idx; idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$repo_root" read-tree HEAD >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" write-tree 2>/dev/null
  rm -f "$idx"
}

# ── Shared re-audit instruction (used by every block path) ───────────────────
# ─────────────────────────────────────────────────────────────────────────────
# The block `reason`s below are the gate's UX + anti-cheating contract — what Claude
# reads when a dossier is missing, stale / mismatched, or FAIL. Invariants to preserve:
#   • Direct Claude to invoke the verdict-auditor subagent (Task tool), passing the
#     transcript path so the auditor can read the very claim it must check.
#   • The AUDITOR — not Claude — writes ${verdict_file}. Claude must not write or
#     hand-edit the dossier (that is grading its own homework / confabulating proof).
#   • Offer the honest exits: IN_PROGRESS if not actually done; a `blocked` proof
#     entry (with residual risk) if proof genuinely can't be produced in this env.
#   • After the auditor reports, end the turn again; this hook re-checks.
#
# Variables available: ${transcript_path} ${branch} ${head} ${verdict_file}
verdict_instruction="Re-audit before ending: invoke the verdict-auditor subagent.
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

# ── No dossier → the turn delta decides ──────────────────────────────────────
# Delta-triggered: turn-baseline.sh snapshotted the tree hash at turn start. If the tree
# changed during the turn, work happened — ending without an audited dossier is blocked.
# No delta means a conversational / acknowledgment turn (including the turns the gate
# itself spawns: audit acks, background-audit completions — the gate's own artifacts are
# gitignored and never register as a delta), which ends freely; that is the loop-safety
# guarantee. A missing or corrupt baseline falls back to self-declared: allow, per
# CLAUDE.md's Verify rule. Verdicts that change no files also land here as no-delta —
# auditing those remains the agent's CLAUDE.md duty, prompted by turn-baseline.sh's
# dirty-tree reminder.
if [[ ! -r "$verdict_file" ]]; then
  baseline="$(head -n1 "$baseline_file" 2>/dev/null || true)"
  [[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || allow
  cur_tree="$(compute_tree_hash)"
  if [[ "$cur_tree" == "$baseline" ]]; then
    allow
  fi
  block "This turn changed the working tree (turn-start ${baseline:0:12} → now ${cur_tree:0:12}) and is ending without an audited verdict.
${verdict_instruction}"
fi

# ── Validate the present dossier ─────────────────────────────────────────────
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
  block "Existing verdict dossier does not match the current working tree:
  dossier.branch=${v_branch}  current=${branch}
  dossier.head=${v_head}      current=${head}
  dossier.tree_hash=${v_tree:0:12}  current=${cur_tree:0:12}
  dossier age: ${age}s (max ${max_age_seconds}s)

The work changed since it was audited. Re-audit is required.
${verdict_instruction}"
fi

if [[ "$v_verdict" == "PASS" ]]; then
  rm -f "$verdict_file"   # consume; next "done" re-checks
  allow
fi

if [[ "$v_verdict" == "IN_PROGRESS" ]]; then
  remaining="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
  rm -f "$verdict_file"
  allow_with_note "Verdict: IN_PROGRESS — proof deferred, work not yet complete:
${remaining}"
fi

# FAIL or any unexpected verdict → block with the findings.
findings="$(jq -r '.findings[]? | "  - " + .' "$verdict_file" 2>/dev/null || echo '')"
block "Verdict proof check FAILED on branch '${branch}':

${findings}

Address each finding, then re-invoke verdict-auditor before ending your turn.
${verdict_instruction}"
