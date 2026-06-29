#!/usr/bin/env bash
# Stop hook: gate the agent from ENDING ITS TURN while it has unproven behavioral
# work, on a fresh dossier from the verdict-auditor subagent
# (see .claude/agents/verdict-auditor.md).
#
# The hook itself does not call any model; it reads the dossier the subagent
# writes at .claude/.last-verdict.json and checks that the verdict is PASS (or
# IN_PROGRESS), recent, and bound to the current branch + HEAD + working-tree hash.
#
# Flow on a blocked stop:
#   1. Hook blocks the turn from ending.
#   2. The `reason` reaches the model; it invokes the verdict-auditor subagent.
#   3. Subagent writes .claude/.last-verdict.json.
#   4. Model ends its turn again -> hook reads the dossier and allows on PASS.
# The subagent's own completion is a SubagentStop event, not Stop, so it does not
# re-trigger this hook (no recursion).
#
# Wired in .claude/settings.json under hooks.Stop (no matcher — fires every turn end).
#
# Design notes
# ------------
# * Every-turn-end: a Stop hook fires whenever the agent ends a turn, with no
#   "done vs paused" signal in the payload. So we first apply a cheap, deterministic
#   PRE-FILTER: unless there are uncommitted changes to PRODUCTION files, we allow
#   immediately. Pure chat / research / docs-only turns never gate. Production is
#   decided by PATH, never by parsing the message (no string-match intent guessing).
#
# * Tree-hash binding: at stop time the work is usually UNCOMMITTED (HEAD has not
#   moved), so HEAD alone can't tell "audited" from "changed since audit". We bind
#   the dossier to a content-addressed hash of the full working tree, computed via a
#   throwaway index + `git write-tree` (deterministic; no timestamps; never touches
#   the real index). The verdict-auditor computes it the SAME way.
#
# * Loop-safety: the block is satisfiable — a fresh PASS or IN_PROGRESS dossier
#   always lets the turn end — so we never depend on the (undocumented) stop_hook_active.
#
# * One-shot consumption: the dossier is `rm -f`'d on the allow path so the next
#   "done" re-checks. Mirrors the trade-off in preflight-commit-push.sh.
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

# ── Pre-filter: is there pending PRODUCTION work worth proving? ───────────────
# Count changed paths that are NOT docs (*.md, docs/) and NOT agent/tooling infra
# (.claude/, .codex/). `grep -c` reads all input (no early-exit SIGPIPE under
# pipefail); `|| true` keeps the no-match exit-1 from aborting.
n_prod="$(git -C "$repo_root" status --porcelain 2>/dev/null \
  | sed -E 's/^.{3}//' \
  | grep -Ecv '(\.md$|^docs/|/docs/|^\.claude/|^\.codex/)' || true)"
if [[ "${n_prod:-0}" -eq 0 ]]; then
  allow
fi

# ── Gate: require a fresh, matching dossier ──────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
# TODO(user, learning-mode): this block `reason` is the gate's UX and its
# anti-cheating contract — what Claude reads when it tries to end a turn with
# unproven behavioral work. Refine the wording to taste, but keep these invariants:
#   • Direct Claude to invoke the verdict-auditor subagent (Task tool), passing the
#     transcript path so the auditor can read the very claim it must check.
#   • The AUDITOR — not Claude — writes ${verdict_file}. Claude must not write or
#     hand-edit the dossier (that is grading its own homework / confabulating proof).
#   • Offer the honest exits: IN_PROGRESS if not actually done; a `blocked` proof
#     entry (with residual risk) if proof genuinely can't be produced in this env.
#   • After the auditor reports, end the turn again; this hook re-checks.
#
# Variables available: ${transcript_path} ${branch} ${head} ${verdict_file}
verdict_instruction="You are ending your turn with unproven changes on branch '${branch}'.
Attach proof for what you claim you did before finishing.

Invoke the verdict-auditor subagent now:
  Task(subagent_type='verdict-auditor',
       description='verdict proof check',
       prompt='Check my last message'\\''s verdict against the working-tree diff.
               transcript_path: ${transcript_path}')

It judges your claims against CLAUDE.md'\\''s Test/Verify rules and writes its dossier
to ${verdict_file}. Do NOT write that file yourself.

If you are not actually done (pausing, or asking the user something), have the
auditor record verdict IN_PROGRESS with what remains. If a claim genuinely cannot
be proven in this environment, the auditor can mark that proof 'blocked' with the
residual risk. Then end your turn again."
# ─────────────────────────────────────────────────────────────────────────────

if [[ ! -r "$verdict_file" ]]; then
  block "No verdict dossier found for the changes in your working tree.

${verdict_instruction}"
fi

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
