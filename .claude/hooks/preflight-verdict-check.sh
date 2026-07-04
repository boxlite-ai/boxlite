#!/usr/bin/env bash
# Stop hook: VALIDATE a self-declared verdict before the agent ends its turn
# (see .claude/agents/verdict-auditor.md).
#
# Self-declared, verdict-scoped: the hook does NOT force an audit and does NOT detect
# verdicts. The agent invokes the verdict-auditor subagent ONLY when it renders a verdict
# (per CLAUDE.md's Verify rule); that writes .claude/.last-verdict.json, which this hook
# validates. A turn with NO dossier means no verdict was declared, and is allowed. This
# hook calls no model and reads no transcript. It is loop-free by construction (see the
# no-dossier branch): a background audit's completion re-invokes a non-verdict turn, which
# has no dossier and passes, so no further audit is triggered.
#
# Flow:
#   1. When the agent renders a verdict, it invokes the verdict-auditor subagent, which
#      writes .claude/.last-verdict.json.
#   2. Hook validates: a fresh, matching PASS/IN_PROGRESS dossier -> allow (consumed).
#   3. NO dossier -> allow: the agent declared no verdict this turn (no forced audit).
#   4. A stale / mismatched / FAIL dossier -> block (hard) or nudge (soft).
# After a block the agent re-audits and ends again. The subagent's own completion is a
# SubagentStop event, not Stop, so it does not re-trigger this hook (no recursion).
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * No detection, self-declared: a Stop hook fires whenever the agent ends a turn, with no
#   "did I render a verdict?" signal. The hook cannot know without either parsing the
#   message prose (rejected — brittle) or forcing an audit on EVERY turn (default-deny —
#   which loops: each audit's completion re-invokes a turn that then demands another
#   audit). So the agent self-declares: it invokes the auditor only on a verdict, and a
#   no-dossier turn is allowed. Trade-off: the hook can't force "audit your verdict"; that
#   is the agent's CLAUDE.md duty, and the auditor still catches wrong claims when invoked.
#
# * Tree-hash binding (present-dossier only): at stop time the work is usually
#   UNCOMMITTED (HEAD has not moved), so HEAD alone can't tell "audited" from
#   "changed since audit". We bind the dossier to a content-addressed hash of the
#   full working tree, computed via a throwaway index + `git write-tree`
#   (deterministic; no timestamps; never touches the real index). The verdict-auditor
#   computes it the SAME way. Computed only when a dossier exists — the no-dossier
#   (allow) path does no git tree work.
#
# * Loop-safety: no-dossier turns are allowed, so a background audit's completion (which
#   re-invokes a NON-verdict turn) never demands another audit — the cycle can't form. Any
#   block (present FAIL / stale dossier) is satisfiable by a fresh PASS / IN_PROGRESS
#   dossier, so we never depend on the (undocumented) stop_hook_active.
#
# * One-shot consumption: the dossier is `rm -f`'d on the allow path so the next
#   verdict re-audits (a stale PASS can't rubber-stamp a later, different claim).
#
# * Present-dossier enforcement: a no-dossier turn is allowed (self-declared), but a
#   dossier that is present and stale / mismatched / FAIL blocks (hard) or nudges (soft)
#   with an instruction to re-invoke the verdict-auditor. So a declared-but-failing verdict
#   still has teeth; only the "no verdict declared" case is trusted to the agent.
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

# ── No dossier → the agent declared no verdict this turn → allow ─────────────
# Self-declared, verdict-scoped: the hook does NOT force an audit. The agent invokes the
# verdict-auditor ONLY when it renders a verdict (per CLAUDE.md's Verify rule), so a
# missing dossier means "no verdict declared" and the turn is allowed. This is what makes
# the gate LOOP-FREE: a background audit's completion re-invokes the agent into a
# non-verdict acknowledgment turn, which produces no dossier and is allowed here — so no
# new audit fires and the audit -> completion -> audit cycle cannot form. (Default-deny,
# which demanded a dossier on EVERY turn, looped for exactly this reason.)
#
# The cost: the hook cannot force "you must audit your verdict" — detecting a verdict would
# need prose-parsing (rejected: brittle) or an audit on every turn (loops). So skipping an
# audit is the agent's failure to follow CLAUDE.md, not something the hook catches. When
# the agent DOES audit, the independent verdict-auditor still catches honest-but-wrong
# claims, and a present FAIL / stale dossier still blocks below.
if [[ ! -r "$verdict_file" ]]; then
  allow
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
