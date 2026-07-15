#!/usr/bin/env bash
# PreToolUse hook: gate `git commit` / `git push` on a fresh audit verdict.
#
# Claude Code produces that verdict through the commit-push-auditor subagent
# (see .claude/agents/commit-push-auditor.md). Codex produces the same artifact
# by running .claude/hooks/run-commit-push-audit.sh, whose default mode invokes
# `codex exec` with hooks disabled.
#
# Flow on a denied attempt:
#   1. Hook denies the git tool call.
#   2. Reason text instructs the parent agent to run the right audit producer.
#   3. The producer writes .claude/.last-audit.json.
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
# ||, ;, |, &, $(, (, `, or a NEWLINE). This catches the chained-command case
# (`cat foo && git commit ...`) AND the multi-line case (`cd foo\ngit commit ...`)
# that an anchor-only matcher misses, while still rejecting literal mentions of
# "git commit" inside string arguments (e.g. `echo "git commit"`), which don't sit
# at the start of a chain segment.
#
# Newline handling: a verb at the start of a physical line runs as a real top-level
# command, exactly like `;`/`&&`. Normalizing newlines to `;` makes the existing
# separator logic catch it. Without this the verb on its own line slips past the
# matcher unaudited (fails OPEN — a silent bypass). Cost: a `git commit`/`git push`
# token on its own line inside a heredoc/message body may falsely match (fails
# CLOSED — a spurious re-audit, never a bypass). Closed-over-open is the right trade.
normalized="${command//$'\n'/;}"
work="${normalized#"${normalized%%[![:space:]]*}"}"
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
audit_file="$project_dir/.claude/.last-audit.json"
handoff_file="$project_dir/.claude/.last-audit-handoff.json"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
max_age_seconds=600

hash_stdin() {
  shasum -a 256 | awk '{print $1}'
}

command_field() {
  local key="$1"
  printf '%s' "$command" | sed -n "s/.* ${key}=\\([0-9a-f][0-9a-f]*\\).*/\\1/p" | head -1
}

push_diff_hash_from_command=""
if [[ "$kind" == "push" ]]; then
  push_diff_hash_from_command="$(command_field pushed_diff_sha256)"
fi

current_diff_hash() {
  case "$kind" in
    commit)
      git -C "$repo_root" diff --cached --no-ext-diff | hash_stdin
      ;;
    push)
      if [[ "$push_diff_hash_from_command" =~ ^[0-9a-f]{64}$ ]]; then
        printf '%s' "$push_diff_hash_from_command"
        return
      fi
      {
        git -C "$repo_root" diff --no-ext-diff origin/main...HEAD 2>/dev/null ||
          git -C "$repo_root" diff --no-ext-diff HEAD~1...HEAD 2>/dev/null ||
          true
      } | hash_stdin
      ;;
    *)
      printf 'unknown' | hash_stdin
      ;;
  esac
}

diff_hash="$(current_diff_hash)"
command_hash="$(printf '%s' "$command" | hash_stdin)"

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

write_command_handoff() {
  jq -nc \
    --arg branch "$branch" \
    --arg head "$head" \
    --arg command_kind "$kind" \
    --arg diff_hash "$diff_hash" \
    --arg command_hash "$command_hash" \
    '{branch:$branch, head:$head, command_kind:$command_kind, diff_hash:$diff_hash, command_hash:$command_hash}' \
    > "$handoff_file"
}

valid_handoff_command_hash() {
  [[ -r "$handoff_file" ]] || return 1

  local handoff_branch handoff_head handoff_kind handoff_diff_hash handoff_command_hash handoff_mtime now_epoch handoff_age
  handoff_branch="$(jq -r '.branch // ""' "$handoff_file" 2>/dev/null || echo '')"
  handoff_head="$(jq -r '.head // ""' "$handoff_file" 2>/dev/null || echo '')"
  handoff_kind="$(jq -r '.command_kind // ""' "$handoff_file" 2>/dev/null || echo '')"
  handoff_diff_hash="$(jq -r '.diff_hash // ""' "$handoff_file" 2>/dev/null || echo '')"
  handoff_command_hash="$(jq -r '.command_hash // ""' "$handoff_file" 2>/dev/null || echo '')"
  handoff_mtime="$(stat -f '%m' "$handoff_file" 2>/dev/null || stat -c '%Y' "$handoff_file" 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  handoff_age=$(( now_epoch - handoff_mtime ))

  if [[ "$handoff_branch" == "$branch" ]] && \
     [[ "$handoff_head" == "$head" ]] && \
     [[ "$handoff_kind" == "$kind" ]] && \
     [[ "$handoff_diff_hash" == "$diff_hash" ]] && \
     [[ -n "$handoff_command_hash" ]] && \
     (( handoff_age <= max_age_seconds )); then
    printf '%s' "$handoff_command_hash"
    return 0
  fi

  return 1
}

claude_invoke_instruction="Invoke the commit-push-auditor subagent now:
  Task(subagent_type='commit-push-auditor',
       description='CLAUDE.md audit',
       prompt='Audit the exact blocked Bash tool_input.command for this git ${kind} on branch ${branch}; copy the command from the tool input, do not paraphrase it.')
The subagent will write its verdict to .claude/.last-audit.json. Retry the
same git command after it reports PASS."

codex_invoke_instruction="Run the Codex audit producer now:
  CODEX_COMMIT_PUSH_AUDIT_MODE=agentic bash .claude/hooks/run-commit-push-audit.sh ${kind} '<target command>'
The producer invokes codex exec with hooks disabled and writes its verdict to
.claude/.last-audit.json. Retry the same git command after it reports PASS.
Set CODEX_BIN to a working Codex CLI binary if the default codex command is not usable."

invoke_instruction="$claude_invoke_instruction"
if [[ -n "${CODEX_SANDBOX:-}" ]]; then
  invoke_instruction="$codex_invoke_instruction"
fi

validate_audit() {
  local consume_on_pass="${1:-consume}"

  if [[ ! -r "$audit_file" ]]; then
    deny "No CLAUDE.md audit found for this change.

${invoke_instruction}"
  fi

  local audit_branch audit_head audit_kind audit_diff_hash audit_command_hash audit_commit_subject_hash audit_verdict audit_mtime now_epoch age
  audit_branch="$(jq -r '.branch // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_head="$(jq -r '.head // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_kind="$(jq -r '.command_kind // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_diff_hash="$(jq -r '.diff_hash // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_command_hash="$(jq -r '.command_hash // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_commit_subject_hash="$(jq -r '.commit_subject_hash // ""' "$audit_file" 2>/dev/null || echo '')"
  audit_verdict="$(jq -r '.verdict // ""' "$audit_file" 2>/dev/null || echo '')"

  if [[ "$kind" == "push" && ! "$push_diff_hash_from_command" =~ ^[0-9a-f]{64}$ ]]; then
    deny "Push audits must be bound to git pre-push ref-update stdin via pushed_diff_sha256.

Retry the push through the git-level pre-push gate so it can produce the exact ref-update audit command."
  fi

  # File mtime as freshness signal: portable across BSD (stat -f %m) and GNU
  # (stat -c %Y) without parsing self-reported timestamps.
  audit_mtime="$(stat -f '%m' "$audit_file" 2>/dev/null || stat -c '%Y' "$audit_file" 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  age=$(( now_epoch - audit_mtime ))

  local command_bound=0 handoff_command_hash=""
  if [[ "$audit_command_hash" == "$command_hash" ]]; then
    command_bound=1
  elif [[ -n "${GITHOOK_DELEGATED:-}" && "$kind" == "commit" ]]; then
    # Only commits may bridge from the PreToolUse command to git's later hooks:
    # commit-msg verifies the final subject before consuming the audit. Pushes
    # must bind to the detailed pre-push command, including ref-update stdin.
    handoff_command_hash="$(valid_handoff_command_hash 2>/dev/null || true)"
    if [[ -n "$handoff_command_hash" && "$audit_command_hash" == "$handoff_command_hash" ]]; then
      command_bound=1
    elif [[ "$kind" == "commit" && -n "$audit_commit_subject_hash" ]]; then
      # Git exposes the real commit message later. The commit-msg hook compares
      # this audited subject hash against the message file before consuming.
      command_bound=1
    fi
  fi

  if [[ "$audit_branch" != "$branch" ]] || \
     [[ "$audit_head" != "$head" ]] || \
     [[ "$audit_kind" != "$kind" ]] || \
     [[ "$audit_diff_hash" != "$diff_hash" ]] || \
     [[ "$command_bound" != 1 ]] || \
     (( age > max_age_seconds )); then
    deny "Existing audit does not match current state:
  audit.branch=${audit_branch}  current=${branch}
  audit.head=${audit_head}      current=${head}
  audit.command_kind=${audit_kind}  current=${kind}
  audit.diff_hash=${audit_diff_hash}  current=${diff_hash}
  audit.command_hash=${audit_command_hash}  current=${command_hash}
  handoff.command_hash=${handoff_command_hash:-none}
  audit age: ${age}s (max ${max_age_seconds}s)

Re-audit is required.
${invoke_instruction}"
  fi

  if [[ "$audit_verdict" != "PASS" ]]; then
    findings="$(jq -r '.findings[]? | "  - " + .' "$audit_file" 2>/dev/null || echo '')"
    deny "CLAUDE.md audit FAILED on branch '${branch}':

${findings}

Address each finding, then re-run the audit producer before retrying git ${kind}."
  fi

  if [[ "$consume_on_pass" == "consume" ]]; then
    rm -f "$audit_file" "$handoff_file"
  fi
}

# Codex should not shell out to the Claude CLI to manufacture the audit
# artifact. When Codex calls this as a PreToolUse hook, run the Codex audit
# producer first; the git-level hook then consumes the same .last-audit.json
# contract below.
codex_pretool_audit=0
if [[ -n "${CODEX_SANDBOX:-}" && -z "${GITHOOK_DELEGATED:-}" ]]; then
  defer_push_to_git_hook=0
  if [[ "$kind" == "push" ]]; then
    hooks_path_for_codex="$(git config core.hooksPath 2>/dev/null || true)"
    if [[ "$hooks_path_for_codex" == *".githooks" ]]; then
      [[ "$hooks_path_for_codex" != /* ]] && hooks_path_for_codex="$repo_root/$hooks_path_for_codex"
      [[ -x "$hooks_path_for_codex/pre-push" ]] && defer_push_to_git_hook=1
    fi
  fi

  if [[ "$defer_push_to_git_hook" != 1 ]]; then
    codex_pretool_audit=1
    codex_auditor="$repo_root/.claude/hooks/run-commit-push-audit.sh"
    if [[ -r "$codex_auditor" ]]; then
      bash "$codex_auditor" "$kind" "$command" >/dev/null 2>&1 || true
    fi
  fi
fi

# Delegate to the git-level gate when installed: with core.hooksPath pointing at
# .githooks, the same contract is enforced by .githooks/pre-commit|pre-push for
# EVERY process (any agent, any harness — and humans stay exempt there), so this
# PreToolUse layer steps aside to keep the audit artifact single-consumer.
# GITHOOK_DELEGATED marks the call coming FROM that git-level gate — the one
# caller that must not be deferred, or the two layers would defer to each other
# and everything would silently pass.
# Defer ONLY when the delegate hook actually exists at this checkout: git skips
# missing hooks silently, so hooksPath-configured + delegate-absent (old ref,
# broken install) would otherwise stand BOTH layers down — a silent bypass.
# Closed-over-open: when in doubt, gate here.
if [[ -z "${GITHOOK_DELEGATED:-}" ]]; then
  hooks_path="$(git config core.hooksPath 2>/dev/null || true)"
  if [[ "$hooks_path" == *".githooks" ]]; then
    [[ "$hooks_path" != /* ]] && hooks_path="$repo_root/$hooks_path"
    if [[ -x "$hooks_path/pre-$kind" ]]; then
      if [[ "$codex_pretool_audit" == 1 ]]; then
        # Validate without consuming: the git-level hook is the single consumer.
        validate_audit keep
      fi
      write_command_handoff
      exit 0
    fi
  fi
fi

if [[ -n "${CODEX_SANDBOX:-}" && -n "${GITHOOK_DELEGATED:-}" && "$kind" == "push" ]]; then
  codex_auditor="$repo_root/.claude/hooks/run-commit-push-audit.sh"
  if [[ -r "$codex_auditor" ]]; then
    bash "$codex_auditor" "$kind" "$command" >/dev/null 2>&1 || true
  fi
fi

# Verdict is PASS, recent, and matches current state — let the git command run.
# Consume the audit file so the next commit/push always re-audits, even if HEAD
# hasn't changed (e.g., user re-stages different content before the next commit).
if [[ -n "${GITHOOK_KEEP_AUDIT:-}" ]]; then
  validate_audit keep
else
  validate_audit consume
fi
exit 0
