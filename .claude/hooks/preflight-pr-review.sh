#!/usr/bin/env bash
# PreToolUse hook: gate `gh pr create` / `gh pr edit` / `gh pr ready` on a
# user-TYPED acknowledgment that they have reviewed the PR.
#
# `gh pr create --draft` (and `-d`) is intentionally excluded — draft PRs are
# not yet requesting review, so no ack is required.
#
# Flow on a denied attempt:
#   1. Hook denies the gh tool call.
#   2. Reason text instructs the parent agent to obtain a TYPED confirmation
#      from the human (not a yes/no click) and persist it verbatim to
#      .claude/.pr-reviewed.json bound to current branch + HEAD.
#   3. Parent retries -> hook validates the marker and allows on match.
#
# Wired in .claude/settings.json under hooks.PreToolUse with matcher "Bash".
#
# Design notes
# ------------
# * Matcher scope: same reason as preflight-commit-push.sh — PreToolUse matchers
#   are tool-name-only. This script does the actual `gh pr <subcmd>` filtering
#   and exits 0 immediately on unrelated bash calls.
#
# * Draft detection caveat: the `--draft` / `-d` check matches anywhere in the
#   raw command string. A title like `--title "[draft] foo"` would falsely
#   skip the ack. The user has accepted this — quoting `--draft` inside an
#   arbitrary string is rare and the failure mode is "let one PR through
#   without ack," not a destructive action.
#
# * One-shot consumption: the marker file is `rm -f`'d on the allow path so
#   each successive gh pr command forces a fresh ack, even at the same HEAD.
#   Mirrors the trade-off in preflight-commit-push.sh.
#
# Tests: bash .claude/hooks/preflight-pr-review.test.sh
set -euo pipefail

payload="$(cat)"
command="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

# Match `gh pr create|edit|ready` at start of command OR at start of any chain
# segment (after &&, ||, ;, |, &, $(, (, `). Same shape as the git matcher in
# preflight-commit-push.sh so chained invocations are caught.
#
# Scan only the FIRST physical line of the command. Multi-line commands almost
# always put the gh invocation on the first line; this excludes heredoc bodies
# (e.g. a `git commit -m "$(cat <<EOF ... gh pr create ... EOF)"` where the
# trigger phrase legitimately appears in commit-message prose) from matching.
# Trade-off: a chained `foo \\\n  && gh pr create` would no longer gate, but
# that form is rare for gh invocations.
first_line="${command%%$'\n'*}"
work="${first_line#"${first_line%%[![:space:]]*}"}"
if [[ "$work" =~ (^|[[:space:]]*(\&\&|\|\||;|\||\&|\$\(|\(|\`)[[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+(create|edit|ready)([[:space:]]|$) ]]; then
  subcmd="${BASH_REMATCH[4]}"
else
  exit 0
fi

# Exclude draft PRs from the gate (only `gh pr create` has --draft).
if [[ "$subcmd" == "create" ]] && [[ "$command" =~ (^|[[:space:]])(--draft|-d)([[:space:]]|=|$) ]]; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
marker_file="$project_dir/.claude/.pr-reviewed.json"
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

# Deterministic title check: when a quoted --title is given, require a
# Conventional-Commit subject <=72 chars. (Short `-t` / unquoted forms aren't
# inspected; body quality / no-narrative is confirmed in the ack below.)
pr_title=""
if [[ "$command" =~ --title[[:space:]]+\"([^\"]*)\" ]]; then
  pr_title="${BASH_REMATCH[1]}"
elif [[ "$command" =~ --title[[:space:]]+\'([^\']*)\' ]]; then
  pr_title="${BASH_REMATCH[1]}"
fi
if [[ -n "$pr_title" ]]; then
  title_re='^(feat|fix|docs|refactor|test|chore|perf|ci|build)(\([^)]+\))?!?:[[:space:]].+'
  if [[ ! "$pr_title" =~ $title_re ]] || (( ${#pr_title} > 72 )); then
    deny "PR title is not a Conventional-Commit subject <=72 chars.
  title (${#pr_title} chars): ${pr_title}
  required: type(scope): summary  — e.g. feat(api): cute default box names
  types: feat fix docs refactor test chore perf ci build

Fix --title and retry. See CONTRIBUTING.md #commit--pr-messages."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# TODO(user, learning-mode): author the ack instructions Claude reads on every
# deny. This is the actual UX of the gate — keep it tight, unambiguous, and
# anti-cheating.
#
# Constraints the message MUST satisfy:
#   • Direct Claude to obtain a TYPED reply from the human (not AskUserQuestion
#     click, not Claude inferring "the user already said yes earlier").
#   • Specify the exact shape the user must type. The hook validates the
#     marker's `.message` field with the regex defined in REQUIRED_MESSAGE_RE
#     below — keep the two in sync.
#   • Tell Claude where to write the marker (path shown via ${marker_file})
#     and what JSON shape: { branch, head, message }.
#   • Forbid Claude from fabricating the message or paraphrasing the user.
#
# Variables available for interpolation:
#   ${command}      the exact gh command being gated
#   ${subcmd}       create | edit | ready
#   ${branch}       current branch
#   ${head}         current HEAD sha
#   ${marker_file}  absolute path Claude must write to
#
# Required regex the user's typed message must match (keep in sync with the
# required phrase shown in ack_instruction below):
REQUIRED_MESSAGE_RE='^reviewed:[[:space:]]+[^[:space:]]'

ack_instruction="PR-review acknowledgment required before: ${command}

Branch: ${branch}    HEAD: ${head:0:12}

Invoke the AskUserQuestion tool. The user will pick 'Other' and type their
acknowledgment into the side-panel text field; their typed text comes back
on the question's 'notes' annotation (not the 'answers' field).

Use this AskUserQuestion payload:
  question: 'PR-review acknowledgment for: ${command}
             First confirm the description follows the PR template and has no
             internal/AI narrative, pasted logs, or secrets. Then pick \"Other\"
             and type your acknowledgment in this exact shape:
                 reviewed: <one-line summary, in your own words, of what
                            this PR changes>'
  header:   'PR review'
  options:
    - label: 'Abort — do not file this PR'
      description: 'Cancel the gh command and return to chat.'
    - label: 'Show me the diff first, then re-ask'
      description: 'Run git diff main...HEAD --stat + git log main..HEAD,
                    display output, then re-invoke AskUserQuestion.'
  multiSelect: false

After AskUserQuestion returns:
  • If the user's typed 'notes' text matches ${REQUIRED_MESSAGE_RE}:
      write it verbatim to:
          ${marker_file}
      as:
          { \"branch\": \"${branch}\",
            \"head\":   \"${head}\",
            \"message\": \"<the user's verbatim typed text>\" }
      then retry the same gh command.
  • If the user picked 'Abort — do not file this PR':
      do NOT write marker, do NOT retry; tell the user the PR was aborted
      and ask what they want to do instead.
  • If the user picked 'Show me the diff first, then re-ask':
      run \`git diff main...HEAD --stat && git log main..HEAD --oneline\`,
      show the output, then re-invoke the SAME AskUserQuestion.
  • If the user typed text in 'Other' but it does not match the regex:
      re-invoke the SAME AskUserQuestion with a one-line note explaining
      the required shape. Do NOT write the marker. Do NOT retry yet.

You MUST NOT fabricate, paraphrase, or pre-fill the summary. Only the user's
verbatim typed text from the AskUserQuestion 'Other' field is acceptable as
the ack."
# ─────────────────────────────────────────────────────────────────────────────

if [[ ! -r "$marker_file" ]]; then
  deny "No PR-review acknowledgment on file for: ${command}

${ack_instruction}"
fi

marker_branch="$(jq -r '.branch // ""' "$marker_file" 2>/dev/null || echo '')"
marker_head="$(jq -r '.head // ""' "$marker_file" 2>/dev/null || echo '')"
marker_message="$(jq -r '.message // ""' "$marker_file" 2>/dev/null || echo '')"

marker_mtime="$(stat -f '%m' "$marker_file" 2>/dev/null || stat -c '%Y' "$marker_file" 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
age=$(( now_epoch - marker_mtime ))

if [[ "$marker_branch" != "$branch" ]] || \
   [[ "$marker_head" != "$head" ]] || \
   (( age > max_age_seconds )); then
  deny "Existing PR-review acknowledgment does not match current state:
  marker.branch=${marker_branch}  current=${branch}
  marker.head=${marker_head}      current=${head}
  marker age: ${age}s (max ${max_age_seconds}s)

Re-acknowledgment required.
${ack_instruction}"
fi

if [[ ! "$marker_message" =~ $REQUIRED_MESSAGE_RE ]]; then
  deny "PR-review acknowledgment message is missing or malformed.
Found: ${marker_message:-<empty>}
Required to match: ${REQUIRED_MESSAGE_RE}

${ack_instruction}"
fi

# Marker is valid for this exact branch+HEAD. Consume it so the next
# gh pr create/edit/ready forces a fresh ack.
rm -f "$marker_file"
exit 0
