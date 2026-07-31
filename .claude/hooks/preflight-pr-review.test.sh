#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-pr-review.sh
#
# Covers:
#   1. Command matcher: gh pr create / edit / ready vs. unrelated bash,
#      chained invocations, draft exclusion.
#   2. Gate logic: missing / mismatched / stale / malformed-message /
#      consumed marker paths.
#
# Run with:  bash .claude/hooks/preflight-pr-review.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-pr-review.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export CLAUDE_PROJECT_DIR="$TMP"
mkdir -p "$TMP/.claude"

BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

pass=0
fail=0

run() {
  local desc="$1" cmd="$2" expect="$3" out decision
  out=$(printf '%s' "$cmd" | jq -Rs '{tool_input:{command:.}}' | "$HOOK")
  if [[ -z "$out" ]]; then
    decision="passthrough"
  else
    decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null || echo "parse_error")
  fi
  if [[ "$decision" == "$expect" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s  (got=%s expected=%s)\n' "$desc" "$decision" "$expect"
  fi
}

write_marker() {
  local message="$1"
  jq -nc --arg b "$BRANCH" --arg h "$HEAD_SHA" --arg m "$message" \
        '{branch:$b, head:$h, message:$m}' \
        > "$TMP/.claude/.pr-reviewed.json"
}

echo "## Matcher: should pass through (not a gated gh pr invocation)"
rm -f "$TMP/.claude/.pr-reviewed.json"
run "ls"                                "ls"                                "passthrough"
run "gh pr list (different subcmd)"     "gh pr list"                        "passthrough"
run "gh pr view (different subcmd)"     "gh pr view 123"                    "passthrough"
run "gh issue create (different verb)"  "gh issue create -t foo"            "passthrough"
run "echo literal mention"              "echo 'gh pr create'"               "passthrough"
run "git push (other hook's domain)"    "git push origin main"              "passthrough"
run "heredoc body mentions trigger"     $'git commit -m "$(cat <<\'EOF\'\nbody mentions `gh pr create`\nEOF\n)"' "passthrough"
run "multiline w/ backtick trigger"     $'git commit -m "fix bug"\n# `gh pr create`' "passthrough"

echo
echo "## Matcher: draft exclusion (only on create)"
run "gh pr create --draft"              "gh pr create --draft -t wip"       "passthrough"
run "gh pr create -d short flag"        "gh pr create -d -t wip"            "passthrough"

echo
echo "## Matcher: should gate"
run "gh pr create direct"               "gh pr create -t foo"               "deny"
run "gh pr edit direct"                 "gh pr edit 42 --body foo"          "deny"
run "gh pr ready direct"                "gh pr ready 42"                    "deny"
run "chained with &&"                   "cd x && gh pr create -t foo"       "deny"
run "chained with ;"                    "echo done; gh pr create -t foo"    "deny"
run "command substitution"              "out=\$(gh pr create -t foo)"       "deny"
run "env var prefix"                    "FOO=bar gh pr create -t foo"       "deny"
# Newline-before-verb: multi-line Bash with the gh invocation on line 2. Before the
# newline-as-separator fix this SILENTLY PASSED THROUGH (the bypass); must deny now.
run "newline before pr create"          $'cd x\ngh pr create -t foo'         "deny"

echo
echo "## Gate logic: marker file states"
write_marker "reviewed: refactor auth middleware"
run "valid marker → allow"              "gh pr create -t foo"               "passthrough"
run "marker consumed on allow"          "gh pr create -t foo"               "deny"

write_marker "reviewed: edit body fix"
run "valid marker for edit → allow"     "gh pr edit 42"                     "passthrough"

write_marker "yes"
run "malformed message → deny"          "gh pr create -t foo"               "deny"

write_marker ""
run "empty message → deny"              "gh pr create -t foo"               "deny"

write_marker "reviewed: stale"
jq --arg h "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" '.head=$h' \
   "$TMP/.claude/.pr-reviewed.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.pr-reviewed.json"
run "HEAD mismatch → deny"              "gh pr create -t foo"               "deny"

write_marker "reviewed: branch test"
jq --arg b "some-other-branch" '.branch=$b' \
   "$TMP/.claude/.pr-reviewed.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.pr-reviewed.json"
run "branch mismatch → deny"            "gh pr create -t foo"               "deny"

write_marker "reviewed: old"
touch -t 202001010000 "$TMP/.claude/.pr-reviewed.json"
run "stale mtime (>max_age) → deny"     "gh pr create -t foo"               "deny"

echo
echo "## Title check: quoted --title must be a Conventional-Commit subject <=72"
write_marker "reviewed: title cases"
run "bad --title (no type prefix) → deny"  'gh pr create --title "add a cool thing" --body x'  "deny"
run "over-72 --title → deny"               'gh pr create --title "feat(api): this title is far too long and clearly exceeds the seventy-two character ceiling"'  "deny"
run "good --title + valid marker → allow"  'gh pr create --title "feat(api): add a cool thing"'  "passthrough"
run "marker consumed after allow → deny"   'gh pr create --title "feat(api): add a cool thing"'  "deny"

echo
echo "## Body check: a supplied --body must carry the before/after call graph"

GRAPH=$'## Call graph\n\nBefore\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)'
FIX_GRAPH=$'## Call graph\n\nBefore\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)  ← BUG: returns before the socket binds\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nFixes #1042'
# The arrow glyph is not part of the contract — ASCII `<-`, or none at all, reads
# the same. What is enforced is the marker's position: on a hop line, in Before.
FIX_ASCII="${FIX_GRAPH/← BUG:/<- BUG:}"
FIX_BARE="${FIX_GRAPH/← BUG:/BUG:}"
FIX_MARK_IN_AFTER=$'## Call graph\n\nBefore\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)  ← BUG: returns before the socket binds\n\nFixes #1042'
FIX_MARK_OFF_HOP=$'## Call graph\n\nBefore\n  ← BUG: open_console returns too early\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nFixes #1042'
FIX_DEBUG_ONLY=$'## Call graph\n\nBefore\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)  debug: enabled\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nFixes #1042'
# Each graph needs a hop of its own — one section cannot borrow the other's.
AFTER_PROSE=$'## Call graph\n\nBefore\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n\nAfter\n  the same hops, but the socket is awaited first'
BEFORE_PROSE=$'## Call graph\n\nBefore\n  exec_box calls open_console, which returns early\n\nAfter\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)'
# Hops sit past the graphs, in a later section — neither graph gets credit.
HOPS_OUTSIDE=$'## Call graph\n\nBefore\n  exec_box calls open_console\n\nAfter\n  exec_box awaits open_console\n\n## Changes\n- exec_box (BoxHandle · src/portal/exec.rs:88)\n- open_console (Jailer · src/jailer/console.rs:41)'
# Graphs drawn in ``` fences, with `##` and `after` lines as graph content:
# inside a fence they are drawing, not markdown structure, so neither may end
# a section early and strand its hops.
FENCED=$'## Call graph\n\nBefore\n\n```text\n## entry\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n```\n\nAfter\n\n```text\n## entry\n  exec_box (BoxHandle · src/portal/exec.rs:88)\n    open_console (Jailer · src/jailer/console.rs:41)\n```'
# The repo's own worked example must clear the gate it documents — including
# its shape, which wraps both labels AND their hops in one fence. Lifted from
# CONTRIBUTING.md at run time so the doc and the hook cannot drift apart.
CONTRIB_FENCE="$(awk '/^```text$/ {i=1; print; next} i && /^```$/ {print; exit} i {print}' "$REPO_ROOT/CONTRIBUTING.md")"
CONTRIB_BODY="## Call graph"$'\n\n'"$CONTRIB_FENCE"
FEAT='--title "feat(api): add a cool thing"'
FIX='--title "fix(portal): await console bind"'

printf '%s' "$GRAPH" > "$TMP/body.md"
printf 'Adds a thing. Tested locally.\n' > "$TMP/prose.md"

# A fresh marker before EVERY case: the allow path consumes it, so without one
# a later case would deny for want of an ack and look like a body-check pass.
run_body() {
  write_marker "reviewed: body cases"
  run "$@"
}

run_body "prose body, no graph → deny"        "gh pr create $FEAT --body \"Adds a thing. Tested locally.\"" "deny"
run_body "graph missing After → deny"         "gh pr create $FEAT --body \"${GRAPH%%$'\n\n'After*}\""       "deny"
run_body "labels but no file:LOC → deny"      "gh pr create $FEAT --body \"## Call graph

Before
  exec_box calls open_console

After
  exec_box awaits open_console\""                                                                           "deny"
run_body "prose-only After → deny"            "gh pr create $FEAT --body \"$AFTER_PROSE\""                  "deny"
run_body "prose-only Before → deny"           "gh pr create $FEAT --body \"$BEFORE_PROSE\""                 "deny"
run_body "hops outside both graphs → deny"    "gh pr create $FEAT --body \"$HOPS_OUTSIDE\""                 "deny"
run_body "unfilled template → deny"           "gh pr create $FEAT --body-file $REPO_ROOT/.github/pull_request_template.md" "deny"
run_body "--fill (no body of its own) → deny" "gh pr create $FEAT --fill"                                   "deny"
run_body "fix: graph w/o BUG marker → deny"   "gh pr create $FIX --body \"$GRAPH\""                         "deny"
run_body "fix: BUG but no issue link → deny"  "gh pr create $FIX --body \"${FIX_GRAPH%%$'\n\n'Fixes*}\""    "deny"
run_body "fix: BUG marked in After → deny"    "gh pr create $FIX --body \"$FIX_MARK_IN_AFTER\""             "deny"
run_body "fix: BUG off any hop line → deny"   "gh pr create $FIX --body \"$FIX_MARK_OFF_HOP\""              "deny"
run_body "fix: 'debug:' is not a marker → deny" "gh pr create $FIX --body \"$FIX_DEBUG_ONLY\""              "deny"
run_body "--body-file prose → deny"           "gh pr create $FEAT --body-file $TMP/prose.md"                "deny"

run_body "gh pr ready (no body flag) → allow" "gh pr ready 42"                                              "passthrough"
run_body "valid graph body → allow"           "gh pr create $FEAT --body \"$GRAPH\""                        "passthrough"
run_body "fenced graphs w/ '##' inside → allow" "gh pr create $FEAT --body \"$FENCED\""                     "passthrough"
run_body "CONTRIBUTING.md's own example → allow" "gh pr create $FIX --body \"$CONTRIB_BODY\""                "passthrough"
run_body "--body-file with graph → allow"     "gh pr create $FEAT --body-file $TMP/body.md"                 "passthrough"
run_body "fix: graph + BUG + issue → allow"   "gh pr create $FIX --body \"$FIX_GRAPH\""                     "passthrough"
run_body "fix: ASCII '<- BUG:' → allow"       "gh pr create $FIX --body \"$FIX_ASCII\""                     "passthrough"
run_body "fix: bare 'BUG:' (no arrow) → allow" "gh pr create $FIX --body \"$FIX_BARE\""                     "passthrough"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
