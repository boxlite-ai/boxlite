#!/usr/bin/env bash
# PostToolUse hook: after a successful remote write, tell the agent to arm a
# Monitor on the pr-watch event stream.
#
# This is the Claude Code *consumer* of the watch. The producer is universal —
# .githooks/pre-push starts .agents/watch/pr-watch.sh for every agent and every
# human. This hook only bridges that stream into a Claude session. Codex,
# opencode, and humans read the same log directly.
#
# Registered from .claude/settings.json (hooks.PostToolUse, matcher "Bash"):
# the vendor directory registers, .agents/ implements.
#
# Design notes
# ------------
# * Advisory, not `decision: "block"`. The push has already happened, so a block
#   cannot undo it — it can only nag. Worse, the auto-fix loop this arms itself
#   ends in a push, so a hard block here would deadlock that loop.
#
# * Matcher scope: PreToolUse/PostToolUse matchers are tool-name-only, so this
#   registers on the broad `Bash` matcher and does its own filtering, exiting 0
#   immediately on unrelated commands. Same shape as
#   .claude/hooks/preflight-commit-push.sh:55 and preflight-pr-review.sh:52 —
#   segment-anchored so `echo "git push"` does not match, newline-normalized so
#   a verb on line 2 does.
#
# * `git push` is matched, but so are the `gh pr` writes. The pre-push arm
#   already covers PR creation transitively (a push always precedes it), so the
#   gh cases exist to re-attach a Monitor in a session that pushed earlier, or
#   where the push happened outside this session.
#
# Tests: bash .agents/hooks/post-remote-write-watch.test.sh
set -euo pipefail

payload="$(cat)"
command="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

normalized="${command//$'\n'/;}"
work="${normalized#"${normalized%%[![:space:]]*}"}"
if [[ "$work" =~ (^|[[:space:]]*(\&\&|\|\||\;|\||\&|\$\(|\(|\`)[[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*git[[:space:]]+push([[:space:]]|$) ]]; then
  :
elif [[ "$work" =~ (^|[[:space:]]*(\&\&|\|\||\;|\||\&|\$\(|\(|\`)[[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+(create|edit|ready|comment|review)([[:space:]]|$) ]]; then
  :
else
  exit 0
fi

[[ "${BOXLITE_PR_WATCH:-1}" == "0" ]] && exit 0

# tool_response is a string for some tools and an object for Bash; accept both
# rather than assuming a shape.
response="$(printf '%s' "$payload" \
  | jq -r 'if (.tool_response | type) == "string"
           then .tool_response
           else ((.tool_response.stdout // "") + "\n" + (.tool_response.stderr // ""))
           end' 2>/dev/null || echo '')"

# A failed push leaves nothing new to watch. PostToolUse never sees the exit
# code, so the decision has to come from git's own output.
#
# Match the whole `error:`/`fatal:` class, not a list of specific messages. A
# local pre-push hook that exits non-zero — this repo's own audit gate — prints
# ONLY `error: failed to push some refs`: no `fatal:`, no `[rejected]`. An
# earlier version enumerated messages, missed that one, and announced a blocked
# push as a successful remote write.
#
# Fails closed: over-matching costs an un-armed watch, under-matching reports a
# push that never happened.
failure_re='(^|[[:space:]])(fatal|error):|\[(remote )?rejected\]|Everything up-to-date|Permission denied'
if [[ "$response" =~ $failure_re ]]; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '')"
[[ -z "$branch" ]] && exit 0

slug="$(git -C "$repo_root" remote get-url origin 2>/dev/null \
        | sed -e 's#^git@[^:]*:##' -e 's#^[a-z+]*://[^/]*/##' -e 's#\.git$##')"

# Prefer the PR the command just produced; fall back to the branch's open PR.
pr_number="$(printf '%s' "$response" \
  | sed -n 's#.*/pull/\([0-9][0-9]*\).*#\1#p' | head -1)"
if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  pr_number="$(gh pr list --repo "$slug" --head "$branch" --state open \
                --json number --jq '.[0].number // empty' 2>/dev/null || echo '')"
fi

state_dir="$(git -C "$repo_root" rev-parse --git-path pr-watch 2>/dev/null || echo '')"
[[ -z "$state_dir" ]] && exit 0
[[ "$state_dir" != /* ]] && state_dir="$repo_root/$state_dir"
event_log="$state_dir/${branch//\//-}.jsonl"

pr_line="No open PR for '${branch}' yet — the watcher polls until one appears."
if [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  pr_line="Watching PR #${pr_number} — https://github.com/${slug}/pull/${pr_number}"
fi

context="A remote write just succeeded on branch '${branch}'.
${pr_line}

.githooks/pre-push has armed the watcher. Arm a Monitor on its event stream now,
in this exact form:

  Monitor({
    command: 'bash ${repo_root}/.agents/watch/pr-watch-stream.sh \"${event_log}\"',
    description: 'CI checks + PR comments on ${branch}',
    persistent: true,
  })

Each line is one JSON event. Kinds: check (one per check as it concludes),
checks_done, comment, review, review_comment, watch_start, watch_end.
The stream ends itself at watch_end — do not arm a second Monitor for this
branch, and do not poll \`gh pr checks\` by hand while it runs.

When an event arrives:
  * bucket 'fail' or 'cancel' -> read the real failure with
      gh run view <run-id> --log-failed
    then follow ${repo_root}/.agents/watch/escalation-policy.md, which decides
    what you may fix unattended and what needs the human. Read it before editing.
  * a new comment or review    -> summarize it for the user; apply the same
    policy before acting on it.
  * send a PushNotification for a failing required check ('Lint (conclusion)',
    'Test (conclusion)') or a new human review — not for routine passes.

If the user asked you not to watch this one, skip the Monitor and say so."

jq -nc --arg c "$context" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $c
  }
}'
exit 0
