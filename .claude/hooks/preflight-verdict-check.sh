#!/usr/bin/env bash
# Stop hook: REQUIRE a verdict dossier before the agent ends its turn
# (see .claude/agents/verdict-auditor.md).
#
# Default-deny gating: the hook does NOT detect verdicts and does NOT decide which turns
# need proof. Every turn-end must produce a dossier at .claude/.last-verdict.json,
# written by the verdict-auditor subagent (per CLAUDE.md's Verify rule). A turn that
# asserts nothing verifiable still produces one — the auditor records a trivial PASS with
# empty proof. This hook only validates that dossier; it calls no model, reads no transcript.
#
# Flow:
#   1. Before ending, the agent invokes the verdict-auditor subagent, which writes
#      .claude/.last-verdict.json (PASS even when there is nothing to prove).
#   2. Hook validates: a fresh, matching PASS/IN_PROGRESS dossier -> allow.
#   3. NO dossier -> block (hard) or nudge (soft): the audit was not run.
#   4. A stale / mismatched / FAIL dossier -> block (hard) or nudge (soft); same path.
# After a block the agent audits and ends again. The subagent's own completion is a
# SubagentStop event, not Stop, so it does not re-trigger this hook (no recursion).
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * No detection, default-deny: a Stop hook fires whenever the agent ends a turn, with
#   no "done vs paused" signal. Rather than guess a verdict from changed files (which
#   misses any verdict that touches no files — an ops check, a factual answer, "no
#   issues") or parse the message, the hook requires a dossier on EVERY turn and lets
#   the AUDITOR classify it (a trivial PASS when there is nothing to prove). A missing
#   dossier is a skipped audit, not a license to skip — closing the hole where a verdict
#   slipped through simply by never invoking the auditor.
#
# * Tree-hash binding (present-dossier only): at stop time the work is usually
#   UNCOMMITTED (HEAD has not moved), so HEAD alone can't tell "audited" from
#   "changed since audit". We bind the dossier to a content-addressed hash of the
#   full working tree, computed via a throwaway index + `git write-tree`
#   (deterministic; no timestamps; never touches the real index). The verdict-auditor
#   computes it the SAME way. Computed only when a dossier exists — the no-dossier
#   block does no git tree work.
#
# * Loop-safety: the block is satisfiable — a fresh PASS or IN_PROGRESS dossier
#   always lets the turn end — so we never depend on the (undocumented) stop_hook_active.
#   A turn that genuinely cannot run the auditor is trapped only in hard mode; soft mode
#   (the default) nudges and lets it through.
#
# * One-shot consumption: the dossier is `rm -f`'d on the allow path so the next
#   turn re-audits. Mirrors the trade-off in preflight-commit-push.sh.
#
# * Deny -> audit -> retry (like preflight-commit-push.sh): on a missing / stale / FAIL
#   dossier the hook blocks (hard) or nudges (soft) with an instruction to invoke the
#   verdict-auditor; the agent audits, then ends again and the hook re-checks. The auditor
#   is async, so in hard mode this is end -> block -> audit -> wait -> end. That block-then-
#   wait is the accepted cost of proof-on-every-turn — there is no async-grace shortcut.
#
# Threat model & accepted limitations (this gate catches HONEST mistakes, not a malicious
# parent — the parent and the auditor share one filesystem + toolset):
#   - NOT forge-resistant: the parent can write the dossier itself. Real tamper-evidence
#     needs a signer the parent cannot impersonate (a harness-level capability) — a shell
#     hook cannot provide it. Out of scope by design.
#   - NOT content-bound: the dossier binds to working-TREE state + verdict, not to the
#     turn's specific claims, so one un-consumed PASS can authorize a same-tree turn whose
#     claims differ. Bounded by one-shot consumption + per-turn re-audit; per-message
#     binding is incompatible with the async model (the auditor audits a mid-turn message,
#     not the final one).
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
# Soft mode (default): emit a non-blocking nudge instead of hard-blocking, so the
# gate does not trap conversational turn-ends while the working tree is dirty. The
# hard proof checkpoint belongs at the commit/push boundary (preflight-commit-push.sh).
# Set VERDICT_GATE_HARD_BLOCK=1 to restore turn-end blocking.
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

# ── No dossier → audit was not run → block (default-deny) ────────────────────
# The heart of default-deny: every turn-end must produce a dossier, so a missing one is a
# skipped audit, not a license to skip. The auditor records a trivial PASS for turns that
# assert nothing — so complying is cheap, and the only thing this rejects is ending WITHOUT
# auditing. Deny -> audit -> retry, like preflight-commit-push.sh: invoke the auditor, then
# end again once the dossier exists (in hard mode that is end -> block -> audit -> end).
if [[ ! -r "$verdict_file" ]]; then
  block "No verdict dossier for this turn — the verdict-auditor was not run.
Every turn must end with a fresh dossier at ${verdict_file}. If this turn asserts
nothing verifiable, the auditor still records a one-line PASS (empty proof) — cheap.
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
