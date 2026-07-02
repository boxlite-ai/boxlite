#!/usr/bin/env bash
# PreToolUse hook: gate `git commit` / `git push` on a fresh verdict from the
# commit-push-auditor subagent (see .claude/agents/commit-push-auditor.md).
#
# The hook itself does not call any model; it only reads the verdict artifact
# the subagent writes at .claude/.last-audit.json and checks that the verdict
# is PASS, recent, and bound to the current branch + HEAD.
#
# Flow on a denied attempt:
#   1. Hook denies the git tool call.
#   2. Reason text instructs the parent agent to invoke the commit-push-auditor
#      subagent via the Task tool, then retry the same git command.
#   3. Subagent writes .claude/.last-audit.json.
#   4. Parent retries -> hook reads the artifact and allows on PASS.
#
# Wired in .claude/settings.json under hooks.PreToolUse with matcher "Bash".
#
# Design notes
# ------------
# * Matcher scope: settings.json registers this hook on the broad `Bash`
#   matcher, not a narrower `Bash:git*` pattern, because Claude Code's
#   PreToolUse matchers are tool-name-only — there's no built-in way to filter
#   on the bash command itself. The script does the actual filtering via the
#   case match below and exits 0 immediately on non-target commands, so the
#   per-invocation cost on unrelated bash calls is one jq parse + one regex.
#
# * One-shot consumption: the audit file is `rm -f`'d on the allow path
#   (intentional, see end of script). This forces a fresh audit on every
#   subsequent git commit/push — even at the same HEAD — so re-staged content
#   between commits can't ride on the previous audit. The cost is that
#   commit-then-push of the same HEAD must re-audit; the user has accepted
#   this trade-off to avoid stale-audit-passes-new-content failure modes.
#
# Tests: bash .claude/hooks/preflight-commit-push.test.sh
set -euo pipefail

payload="$(cat)"
command="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

# Match when the command actually IS a `git commit` / `git push` invocation —
# at the start of the command OR at the start of any chain segment (after &&,
# ||, ;, |, &, $(, (, `). This catches the chained-command case
# (`cat foo && git commit ...`) that an anchor-only matcher misses, while still
# rejecting literal mentions of "git commit" inside string arguments (e.g.
# `echo "git commit"`), which don't sit at the start of a chain segment.
work="${command#"${command%%[![:space:]]*}"}"
if [[ "$work" =~ (^|[[:space:]]*(\&\&|\|\||;|\||\&|\$\(|\(|\`)[[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*git[[:space:]]+(commit|push)([[:space:]]|$) ]]; then
  case "${BASH_REMATCH[4]}" in
    commit) kind="commit" ;;
    push)   kind="push"   ;;
    *)      exit 0 ;;
  esac
else
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
audit_file="$project_dir/.claude/.last-audit.json"
max_age_seconds=600

deny() {
  jq -nc --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

invoke_instruction="Invoke the commit-push-auditor subagent now:
  Task(subagent_type='commit-push-auditor',
       description='CLAUDE.md audit',
       prompt='Audit the pending \`${command}\` on branch ${branch}.')
The subagent will write its verdict to .claude/.last-audit.json. Retry the
same git command after it reports PASS."

if [[ ! -r "$audit_file" ]]; then
  deny "No CLAUDE.md audit found for this change.

${invoke_instruction}"
fi

audit_branch="$(jq -r '.branch // ""' "$audit_file" 2>/dev/null || echo '')"
audit_head="$(jq -r '.head // ""' "$audit_file" 2>/dev/null || echo '')"
audit_kind="$(jq -r '.command_kind // ""' "$audit_file" 2>/dev/null || echo '')"
audit_verdict="$(jq -r '.verdict // ""' "$audit_file" 2>/dev/null || echo '')"

# File mtime as freshness signal — portable across BSD (stat -f %m) and GNU
# (stat -c %Y) without parsing self-reported timestamps.
audit_mtime="$(stat -f '%m' "$audit_file" 2>/dev/null || stat -c '%Y' "$audit_file" 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
age=$(( now_epoch - audit_mtime ))

if [[ "$audit_branch" != "$branch" ]] || \
   [[ "$audit_head" != "$head" ]] || \
   [[ "$audit_kind" != "$kind" ]] || \
   (( age > max_age_seconds )); then
  deny "Existing audit does not match current state:
  audit.branch=${audit_branch}  current=${branch}
  audit.head=${audit_head}      current=${head}
  audit.command_kind=${audit_kind}  current=${kind}
  audit age: ${age}s (max ${max_age_seconds}s)

Re-audit is required.
${invoke_instruction}"
fi

if [[ "$audit_verdict" != "PASS" ]]; then
  findings="$(jq -r '.findings[]? | "  - " + .' "$audit_file" 2>/dev/null || echo '')"
  deny "CLAUDE.md audit FAILED on branch '${branch}':

${findings}

Address each finding, then re-invoke commit-push-auditor before retrying \`${command}\`."
fi

# Verdict is PASS, recent, and matches current state — let the git command run.
# Consume the audit file so the next commit/push always re-audits, even if HEAD
# hasn't changed (e.g., user re-stages different content before the next commit).
rm -f "$audit_file"
exit 0
