#!/usr/bin/env bash
# Tests for .agents/hooks/post-remote-write-watch.sh
#
# Covers:
#   1. Command matcher: git push / gh pr writes vs. unrelated bash, chained and
#      multi-line forms, literal mentions.
#   2. Failure handling: a rejected or no-op push must not arm anything.
#   3. PR-number resolution from the tool response.
#
# `gh` is stubbed on PATH — this suite makes no network calls.
#
# Run with:  bash .agents/hooks/post-remote-write-watch.test.sh
# Exits non-zero on any failure.
set -uo pipefail

# Resolve from THIS script's location, not the caller's cwd. `git rev-parse
# --show-toplevel` returns whatever checkout the shell happens to sit in, so
# running this suite from another directory silently tests that checkout's hook
# instead of the one shipped beside these tests — a reverted-hook two-side check
# then reports a false pass.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.agents/hooks/post-remote-write-watch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/bin"
mkdir -p "$STUB"
cat > "$STUB/gh" <<'EOF'
#!/usr/bin/env bash
# Only `gh pr list --json number` is reached from the hook.
printf '%s\n' "${STUB_PR_NUMBER:-}"
EOF
chmod +x "$STUB/gh"
export PATH="$STUB:$PATH"

# The hook's opt-out, and the one knob CONTRIBUTING tells developers to export.
# Inherited from the caller it silences every arm case, giving the same 17/14 the
# detached-cwd bug did — loud, but attributed to the wrong thing: 14 arm cases fail
# for a reason that is nowhere in the diff being tested. The dedicated case below
# sets it explicitly.
unset BOXLITE_PR_WATCH

# Hermetic repo. The hook reads `git branch --show-current` from its cwd and exits
# 0 when that is empty, so run from a detached worktree every "should arm" case
# reported passthrough and the suite scored 17/14 instead of 31/0. Pin the branch
# and the remote here, so that together with the unset above the suite gives the
# same answer wherever it is invoked from.
REPO="$TMP/repo"
git init -q -b harness-branch "$REPO"
git -C "$REPO" remote add origin git@github.com:acme/widget.git
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
cd "$REPO" || exit 1

pass=0
fail=0

# Feed a PostToolUse payload; report "armed" when the hook injects context.
run() {
  local desc="$1" cmd="$2" resp="$3" expect="$4" out decision
  out=$(jq -nc --arg c "$cmd" --arg r "$resp" \
          '{tool_input:{command:$c}, tool_response:{stdout:$r, stderr:""}}' \
        | "$HOOK" 2>/dev/null)
  if [[ -z "$out" ]]; then
    decision="passthrough"
  elif printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1; then
    decision="armed"
  else
    decision="parse_error"
  fi
  if [[ "$decision" == "$expect" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s expected=%s)\n' "$desc" "$decision" "$expect"
  fi
}

export STUB_PR_NUMBER=42

echo "## Matcher: should pass through"
run "ls"                          "ls"                        ""  "passthrough"
run "git status"                  "git status"                ""  "passthrough"
run "git commit (not a push)"     "git commit -m x"           ""  "passthrough"
run "gh pr list"                  "gh pr list"                ""  "passthrough"
run "gh pr view"                  "gh pr view 42"             ""  "passthrough"
run "gh issue create"             "gh issue create -t x"      ""  "passthrough"
run "echo literal git push"       "echo 'git push'"           ""  "passthrough"
run "echo literal gh pr create"   "echo 'gh pr create'"       ""  "passthrough"
run "heredoc body mentions push"  $'git commit -m "$(cat <<\'EOF\'\nmentions `git push`\nEOF\n)"' "" "passthrough"

echo
echo "## Matcher: should arm"
run "git push direct"             "git push"                  ""  "armed"
run "git push with args"          "git push -u origin feat"   ""  "armed"
run "gh pr create"                "gh pr create -t x"         ""  "armed"
run "gh pr ready"                 "gh pr ready 42"            ""  "armed"
run "gh pr comment"               "gh pr comment 42 -b hi"    ""  "armed"
run "gh pr review"                "gh pr review 42 -a"        ""  "armed"
run "chained with &&"             "cd x && git push"          ""  "armed"
run "chained with ;"              "echo done; git push"       ""  "armed"
run "env var prefix"              "FOO=bar git push"          ""  "armed"
run "newline before verb"         $'cd x\ngit push'           ""  "armed"

echo
echo "## Failed remote writes must not arm"
run "rejected push"               "git push" "! [rejected] main -> main (fetch first)" "passthrough"
run "fatal push"                  "git push" "fatal: repository not found"             "passthrough"
run "everything up-to-date"       "git push" "Everything up-to-date"                   "passthrough"
run "permission denied"           "git push" "Permission denied (publickey)"           "passthrough"
run "remote rejected"             "git push" "! [remote rejected] main -> main (pre-receive hook declined)" "passthrough"
# git's generic summary line. A local pre-push hook that exits non-zero (this
# repo's own audit gate) prints ONLY this — no 'fatal:', no '[rejected]' — so
# without it the hook reports a blocked push as a successful remote write.
run "pre-push hook declined"      "git push" "error: failed to push some refs to 'github.com:boxlite-ai/boxlite.git'" "passthrough"
run "src refspec error"           "git push" "error: src refspec main does not match any" "passthrough"

echo
echo "## Opt-out"
out=$(jq -nc '{tool_input:{command:"git push"}, tool_response:{stdout:"",stderr:""}}' \
      | BOXLITE_PR_WATCH=0 "$HOOK" 2>/dev/null)
if [[ -z "$out" ]]; then
  pass=$((pass + 1)); printf '  PASS  BOXLITE_PR_WATCH=0 passes through\n'
else
  fail=$((fail + 1)); printf '  FAIL  BOXLITE_PR_WATCH=0 passes through (got output)\n'
fi

echo
echo "## PR resolution"
ctx() {
  jq -nc --arg c "$1" --arg r "$2" \
     '{tool_input:{command:$c}, tool_response:{stdout:$r, stderr:""}}' \
   | "$HOOK" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext // ""'
}

got="$(ctx "gh pr create -t x" "https://github.com/boxlite-ai/boxlite/pull/1234")"
if [[ "$got" == *"PR #1234"* ]]; then
  pass=$((pass + 1)); printf '  PASS  PR number read from the create URL\n'
else
  fail=$((fail + 1)); printf '  FAIL  PR number read from the create URL\n'
fi

got="$(ctx "git push" "")"
if [[ "$got" == *"PR #42"* ]]; then
  pass=$((pass + 1)); printf '  PASS  falls back to the branch'"'"'s open PR\n'
else
  fail=$((fail + 1)); printf '  FAIL  falls back to the branch'"'"'s open PR (got: %.60s)\n' "$got"
fi

# Prefix form, not a bare assignment: `VAR="" got="$(…)"` is TWO assignments, so
# the empty value would persist and silently re-point every later case at the
# no-PR branch. `ctx` is a function, so the prefix scopes it to this call.
got="$(STUB_PR_NUMBER="" ctx "git push" "")"
if [[ "$got" == *"No open PR"* ]]; then
  pass=$((pass + 1)); printf '  PASS  no PR yet still arms, noting the watcher polls\n'
else
  fail=$((fail + 1)); printf '  FAIL  no PR yet still arms, noting the watcher polls\n'
fi

got="$(ctx "git push" "")"
if [[ "$got" == *"escalation-policy.md"* && "$got" == *"pr-watch-stream.sh"* ]]; then
  pass=$((pass + 1)); printf '  PASS  context names the stream script and the policy\n'
else
  fail=$((fail + 1)); printf '  FAIL  context names the stream script and the policy\n'
fi

echo
printf 'post-remote-write-watch: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
