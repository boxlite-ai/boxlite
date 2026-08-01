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
# * Two deterministic content checks run before the ack gate — a Conventional-
#   Commit `--title`, and a `--body` carrying the before/after call graph
#   (CONTRIBUTING.md #commit--pr-messages). Both only fire when the flag is
#   actually present and inspectable; neither consumes the ack marker.
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
# Treat a newline as a command separator (same as `;`), so a `gh pr create` at the
# start of a later line (`cd foo\ngh pr create ...`) is caught. An earlier version
# scanned only the first physical line to dodge heredoc bodies (e.g. `gh pr create`
# appearing in commit-message prose), but that left the newline bypass OPEN — a real
# `gh pr create` on line 2 slipped past unaudited. Closing the bypass wins: the cost
# is that a `gh pr create|edit|ready` token on its own line inside a heredoc/message
# body may falsely gate an unrelated command (fails CLOSED — safe), which is rare.
normalized="${command//$'\n'/;}"
work="${normalized#"${normalized%%[![:space:]]*}"}"
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

# Deterministic body check: a supplied PR body must carry the before/after
# end-to-end call graph mandated by CONTRIBUTING.md #commit--pr-messages.
#
# Only inspected when the command actually supplies a body. `gh pr ready` and
# editor-driven `gh pr create` carry nothing to read, and the editor path opens
# .github/pull_request_template.md, which already holds the section.
pr_body=""
body_supplied=0
if [[ "$command" =~ (^|[[:space:]])(--body-file|-F)[[:space:]]+([^[:space:]]+) ]]; then
  body_supplied=1
  body_path="${BASH_REMATCH[3]//[\"\']/}"
  [[ -r "$body_path" ]] && pr_body="$(cat "$body_path")"
elif [[ "$command" =~ (^|[[:space:]])(--body|-b)[[:space:]]+\"([^\"]*)\" ]]; then
  # Covers both `--body "…"` and `--body "$(cat <<'EOF' … EOF)"`: the capture stops
  # at the next `"`, so a body containing a double quote truncates and fails the
  # checks below — closed, not open.
  body_supplied=1
  pr_body="${BASH_REMATCH[3]}"
elif [[ "$command" =~ (^|[[:space:]])(--body|-b)[[:space:]]+\'([^\']*)\' ]]; then
  body_supplied=1
  pr_body="${BASH_REMATCH[3]}"
elif [[ "$command" =~ (^|[[:space:]])(--body|-b|--fill|--fill-first|--fill-verbose|-f)([[:space:]]|=|$) ]]; then
  # A body flag we cannot read (unquoted `--body`), or `--fill`, which supplies no
  # body of its own — commit text is not a PR description.
  body_supplied=1
  pr_body="$command"
fi

if (( body_supplied )); then
  # Line-start anchors below: an extracted body begins mid-line, glued to the flag.
  pr_body=$'\n'"$pr_body"
  body_lc="$(tr '[:upper:]' '[:lower:]' <<<"$pr_body")"
  # Herestrings, not pipes: `grep -q` exits on first match and would SIGPIPE the
  # writer, which `set -o pipefail` would then read as a failed check.
  has_line() { grep -qE "$1" <<<"$body_lc"; }
  missing=""

  has_line '^[[:space:]]*#{2,}[[:space:]]*call[[:space:]]+graph[[:space:]]*$' \
    || missing+="
  - a '## Call graph' section"
  # Shared with the section extractor below, so the header shape can never
  # drift between "is there a Before label" and "where does Before end".
  before_re='^[[:space:]]*before([[:space:]]|:|$)'
  after_re='^[[:space:]]*after([[:space:]]|:|$)'
  has_line "$before_re" \
    || missing+="
  - a 'Before' graph"
  has_line "$after_re" \
    || missing+="
  - an 'After' graph"

  # Lines strictly between a graph's header and whichever comes first: the
  # other graph's header, or the next markdown heading. Rule order is
  # load-bearing: reset on a stop, then print, then set on the header — that
  # sequence is what keeps the header lines themselves out of the section, so a
  # marker on the `Before` line marks no hop.
  #
  # Only the heading stop is fence-aware. Graphs get drawn inside a ``` fence,
  # where a `## entry` line is drawing rather than structure, and honouring it
  # stranded every hop that followed. The graph labels are honoured fenced or
  # not, because CONTRIBUTING.md's own example wraps both labels and all their
  # hops in a single fence — gating the labels the same way left that example
  # extracting to nothing and denied for having no hops at all.
  section() {
    awk -v start_re="$1" -v stop_re="$2" '
      /^[[:space:]]*```/                        { fenced = !fenced }
      $0 ~ stop_re && in_section                { in_section = 0 }
      !fenced && /^[[:space:]]*##/ && in_section { in_section = 0 }
      in_section                                { print }
      $0 ~ start_re                             { in_section = 1 }
    ' <<<"$body_lc"
  }
  before_graph="$(section "$before_re" "$after_re")"
  after_graph="$(section "$after_re" "$before_re")"

  # Each graph needs a hop of its own, shaped like the documented
  # `fn_name (Type · path/file.ext:LOC)`. Matching a bare `file.ext:LOC` was
  # too loose — one occurs mid-sentence — so a paragraph mentioning a file in
  # passing counted as a graph.
  #
  # What it actually requires: a `(` to the left of the reference and a `)` to
  # the right. Not a balanced group, and neither side is stricter than the
  # other. Being permissive is deliberate — a Type half carries its own
  # parentheses in `(fn(u32) -> u32 · src/x.rs:5)`, and refusing to cross them
  # denied a hop conforming to CONTRIBUTING.md's documented shape. The cost is
  # that an unrelated parenthetical straddling the reference also satisfies it.
  #
  # So this only reaches "shaped like a hop". It cannot tell a real graph from
  # a fabricated one, and no pattern here could — that judgment is left to the
  # human on the typed `reviewed:` ack below.
  #
  # Per graph, not body-wide: a body-wide count lets a prose-only After ride
  # along on Before's hops, which is not an end-to-end before/after graph. It
  # is also what an unfilled template cannot fake — its labels are literal
  # text, but its hop lines are HTML comments.
  hop_re='\(.*[A-Za-z0-9_./-]+\.[A-Za-z]+:[0-9]+.*\)'
  before_hops="$(grep -cE "$hop_re" <<<"$before_graph" || true)"
  after_hops="$(grep -cE "$hop_re" <<<"$after_graph" || true)"
  # Reports what is checked — a parenthesised reference — rather than naming
  # parts (`fn_name`, `Type`) the pattern does not require; the canonical shape
  # is printed in full below.
  (( before_hops >= 1 && after_hops >= 1 )) \
    || missing+="
  - a hop line with a parenthesised 'path/file.ext:LOC' in each graph, shaped as below (found ${before_hops} in Before, ${after_hops} in After)"

  # Bug-fix extras — only decidable when --title was inspectable above.
  if [[ "$pr_title" =~ ^fix(\([^\)]+\))?!?: ]]; then
    # "Mark the faulty hop" is literal: the marker has to sit on a hop line
    # inside the Before graph. A `BUG:` loose in prose, or down in After, marks
    # nothing. The arrow is deliberately not required — `←`, `<-` and a bare
    # `BUG:` all read the same, and mandating one Unicode glyph is typing
    # friction, not signal. The word boundary keeps `debug:` from qualifying.
    marker_re='(^|[^[:alnum:]_])bug:'
    # Same line, either order: `hop … ← BUG: why` or `← BUG: why … hop`.
    marked_hop() {
      grep -qE "${hop_re}.*${marker_re}" <<<"$before_graph" ||
        grep -qE "${marker_re}.*${hop_re}" <<<"$before_graph"
    }
    marked_hop \
      || missing+="
  - fix: PR — '← BUG: <what goes wrong>' on a hop line inside the Before graph"
    has_line '(fixes|closes|resolves)[[:space:]]+#[0-9]+' \
      || missing+="
  - fix: PR — an issue link, 'Fixes #<n>'"
  fi

  if [[ -n "$missing" ]]; then
    deny "PR description is missing the mandated before/after call graph.

Missing:${missing}

Shape — one line per hop, only the hops this PR changes:
  Before
    exec_box            (BoxHandle · src/boxlite/src/portal/exec.rs:88)
      └─ open_console   (Jailer · src/boxlite/src/jailer/console.rs:41)  ← BUG: returns before the socket binds
  After
    exec_box            (BoxHandle · src/boxlite/src/portal/exec.rs:88)
      └─ open_console   (Jailer · src/boxlite/src/jailer/console.rs:41)  — awaits the bind future

Read the real call sites before writing the graph — a graph with invented
symbols or stale line numbers is worse than none.

Rewrite the body and retry. Rule and full example: CONTRIBUTING.md
#commit--pr-messages; section layout: .github/pull_request_template.md."
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

marker_mtime="$(file_mtime_epoch "$marker_file")"
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
