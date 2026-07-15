#!/usr/bin/env bash
# Tests for .claude/hooks/preflight-commit-push.sh
#
# Covers the two areas CLAUDE.md flags for required tests on this change:
#   1. Command matcher (parsing + branching): direct invocation vs. chain
#      segments vs. literal-string mentions inside arguments.
#   2. Gate logic (branching + boundary validation): missing / mismatched /
#      stale / FAIL / consumed audit-file paths.
#
# Run with:  bash .claude/hooks/preflight-commit-push.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/preflight-commit-push.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Redirect the hook's audit-file lookup into TMP so tests don't touch the real
# .claude/.last-audit.json. The hook still uses git from the real repo for
# branch/HEAD detection — that's fine, we read the same values for assertions.
export CLAUDE_PROJECT_DIR="$TMP"
mkdir -p "$TMP/.claude"
unset CODEX_SANDBOX CLAUDECODE AGENT_GATED

BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

pass=0
fail=0

hash_stdin() {
  shasum -a 256 | awk '{print $1}'
}

diff_hash_for() {
  local kind="$1" repo="${2:-$REPO_ROOT}"
  case "$kind" in
    commit) git -C "$repo" diff --cached --no-ext-diff | hash_stdin ;;
    push)
      {
        git -C "$repo" diff --no-ext-diff origin/main...HEAD 2>/dev/null ||
          git -C "$repo" diff --no-ext-diff HEAD~1...HEAD 2>/dev/null ||
          true
      } | hash_stdin
      ;;
    *) printf 'unknown' | hash_stdin ;;
  esac
}

command_hash_for() {
  printf '%s' "$1" | hash_stdin
}

subject_hash_for() {
  local command="$1" subject="" rest=""
  case "$command" in
    *" -m '"*) rest="${command#*" -m '"}"; subject="${rest%%\'*}" ;;
    *' -m "'*) rest="${command#*' -m "'}"; subject="${rest%%\"*}" ;;
    *" --message '"*) rest="${command#*" --message '"}"; subject="${rest%%\'*}" ;;
    *' --message "'*) rest="${command#*' --message "'}"; subject="${rest%%\"*}" ;;
  esac
  if [[ -n "$subject" ]]; then
    printf '%s' "$subject" | hash_stdin
  fi
}

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

write_audit() {
  local verdict="$1" findings_json="$2" kind="$3" command="${4:-}"
  if [[ -z "$command" ]]; then
    case "$kind" in
      commit) command="git commit -m foo" ;;
      push) command="git push origin main" ;;
      *) command="git ${kind}" ;;
    esac
  fi
  jq -nc --arg b "$BRANCH" --arg h "$HEAD_SHA" \
        --arg v "$verdict" --arg k "$kind" \
        --arg dh "$(diff_hash_for "$kind")" \
        --arg ch "$(command_hash_for "$command")" \
        --arg csh "$(subject_hash_for "$command")" \
        --argjson f "$findings_json" \
        '{branch:$b, head:$h, command_kind:$k, diff_hash:$dh, command_hash:$ch, commit_subject_hash:$csh, verdict:$v, findings:$f}' \
        > "$TMP/.claude/.last-audit.json"
}

GC='git commit'
GP='git push'

echo "## Matcher: should pass through (not a git commit/push invocation)"
rm -f "$TMP/.claude/.last-audit.json"
run "ls"                                "ls"                          "passthrough"
run "echo with literal mention"         "echo \"$GC\""                "passthrough"
run "grep with literal mention"         "grep \"$GC\" file"           "passthrough"
run "git status (different verb)"       "git status"                  "passthrough"
run "git log (different verb)"          "git log --oneline -5"        "passthrough"

echo
echo "## Matcher: should gate (real git commit/push invocation)"
run "direct commit"                     "$GC -m wip"                  "deny"
run "direct push"                       "$GP origin main"             "deny"
run "chained with &&"                   "cd x && $GC -m wip"          "deny"
run "chained with ||"                   "true || $GC -m foo"          "deny"
run "chained with ;"                    "echo done; $GC"              "deny"
run "env var prefix"                    "FOO=bar $GC -m x"            "deny"
run "command substitution"              "out=\$($GC -m foo)"          "deny"
run "push after &&"                     "cat x && $GP origin main"    "deny"
# Newline-before-verb: multi-line Bash where the verb starts line 2. Before the
# newline-as-separator fix these SILENTLY PASSED THROUGH (the bypass); must deny now.
run "newline before commit"             $'cd x\n'"$GC -m wip"          "deny"
run "newline before push"               $'cd x\n'"$GP origin main"     "deny"

echo
echo "## Gate logic: audit file states"
write_audit "PASS" "[]" "commit"
run "PASS verdict matches → allow"      "$GC -m foo"                  "passthrough"
run "verdict consumed on allow"         "$GC -m foo"                  "deny"

write_audit "FAIL" '["Test: missing"]' "commit"
run "FAIL verdict → deny"               "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
# Mutate head field to simulate a stale-by-HEAD audit
jq --arg h "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" '.head=$h' \
   "$TMP/.claude/.last-audit.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.last-audit.json"
run "HEAD mismatch → deny"              "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
touch -t 202001010000 "$TMP/.claude/.last-audit.json"
run "stale mtime (>max_age) → deny"     "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit"
run "kind mismatch (commit vs push)"    "$GP origin main"             "deny"

write_audit "PASS" "[]" "commit"
jq '.diff_hash="0000000000000000000000000000000000000000000000000000000000000000"' \
   "$TMP/.claude/.last-audit.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.last-audit.json"
run "diff hash mismatch → deny"         "$GC -m foo"                  "deny"

write_audit "PASS" "[]" "commit" "$GC -m other"
run "command hash mismatch → deny"      "$GC -m foo"                  "deny"

pushed_hash="1111111111111111111111111111111111111111111111111111111111111111"
write_audit "PASS" "[]" "push" "$GP origin main"
jq --arg dh "$pushed_hash" '.diff_hash=$dh' \
   "$TMP/.claude/.last-audit.json" > "$TMP/.claude/x.json" \
   && mv "$TMP/.claude/x.json" "$TMP/.claude/.last-audit.json"
jq -nc --arg b "$BRANCH" --arg h "$HEAD_SHA" \
      --arg k "push" \
      --arg dh "$pushed_hash" \
      --arg ch "$(command_hash_for "$GP origin main")" \
      '{branch:$b, head:$h, command_kind:$k, diff_hash:$dh, command_hash:$ch}' \
      > "$TMP/.claude/.last-audit-handoff.json"
synthetic_push="$GP --pre-push-hook remote=origin remote_url_sha256=0000000000000000000000000000000000000000000000000000000000000000 ref_updates_sha256=0000000000000000000000000000000000000000000000000000000000000000 pushed_diff_sha256=$pushed_hash"
out=$(printf '%s' "$synthetic_push" | jq -Rs '{tool_input:{command:.}}' | GITHOOK_DELEGATED=1 "$HOOK")
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null || echo "parse_error")
if [[ "$decision" == "deny" ]]; then
  pass=$((pass + 1))
  printf '  PASS  delegated push ignores generic handoff hash\n'
else
  fail=$((fail + 1))
  printf '  FAIL  delegated push ignores generic handoff hash  (got=%s expected=deny)\n' "$decision"
fi
rm -f "$TMP/.claude/.last-audit-handoff.json"

echo
echo "## Codex: local deterministic audit writes the required artifact"
CODEX_REPO="$(mktemp -d)"
git -C "$CODEX_REPO" init -q
git -C "$CODEX_REPO" config user.email t@t.test
git -C "$CODEX_REPO" config user.name tester
mkdir -p "$CODEX_REPO/.claude/hooks"
cp "$HOOK" "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" "$CODEX_REPO/.claude/hooks/"
printf 'base\n' > "$CODEX_REPO/f"
git -C "$CODEX_REPO" add -A
git -C "$CODEX_REPO" commit -qm base
printf 'change\n' >> "$CODEX_REPO/f"
git -C "$CODEX_REPO" add -A
out="$(printf '{"tool_input":{"command":"git commit -m '\''test(net): cover hook audit'\''"}}' \
      | ( cd "$CODEX_REPO" && CLAUDE_PROJECT_DIR="$CODEX_REPO" CODEX_SANDBOX=seatbelt CODEX_COMMIT_PUSH_AUDIT_MODE=local bash "$CODEX_REPO/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
if [[ -z "$out" && ! -e "$CODEX_REPO/.claude/.last-audit.json" ]]; then
  pass=$((pass + 1))
  printf '  PASS  Codex local audit allows and is consumed\n'
else
  fail=$((fail + 1))
  printf '  FAIL  Codex local audit allows and is consumed  (out=%s audit_exists=%s)\n' "${out:-EMPTY}" "$([[ -e "$CODEX_REPO/.claude/.last-audit.json" ]] && echo yes || echo no)"
fi
rm -rf "$CODEX_REPO"

echo
echo "## Codex: agentic audit invokes codex exec with schema and hooks disabled"
AGENTIC_REPO="$(mktemp -d)"
git -C "$AGENTIC_REPO" init -q
git -C "$AGENTIC_REPO" config user.email t@t.test
git -C "$AGENTIC_REPO" config user.name tester
mkdir -p "$AGENTIC_REPO/.claude/hooks" "$AGENTIC_REPO/bin"
cp "$HOOK" \
   "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
   "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
   "$AGENTIC_REPO/.claude/hooks/"
printf 'base\n' > "$AGENTIC_REPO/f"
git -C "$AGENTIC_REPO" add -A
git -C "$AGENTIC_REPO" commit -qm base
printf 'change\n' >> "$AGENTIC_REPO/f"
{
  printf 'api_key = short-secret\n'
  printf 'token = "short secret with spaces"\n'
  printf "secret: 'single quoted secret'\n"
  printf 'DATABASE_URL=postgres://dbuser:dbpass@example.test/app\n'
  printf 'service_url = "https://urluser:urlpass@example.test/path"\n'
  printf 'callback=https://example.test/hook?api_key=raw-query-key&client_secret=raw-client-value\n'
} > "$AGENTIC_REPO/secret.txt"
git -C "$AGENTIC_REPO" add -A
cat > "$AGENTIC_REPO/bin/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi

approval=""; exec_seen=no; disable_hooks=no; sandbox=""; cd_arg=""; schema=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ask-for-approval) approval="$2"; shift 2 ;;
    exec) exec_seen=yes; shift ;;
    --disable)
      if [[ "$2" == "hooks" ]]; then disable_hooks=yes; fi
      shift 2
      ;;
    --sandbox) sandbox="$2"; shift 2 ;;
    --cd) cd_arg="$2"; shift 2 ;;
    --ephemeral) shift ;;
    --output-schema) schema="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    *) shift ;;
  esac
done

printf '%s\n' "$prompt" > "$cd_arg/prompt.txt"
command_json_line="$(printf '%s\n' "$prompt" | sed -n '/^{"target_command":/p')"
command_length="$(printf '%s' "$command_json_line" | jq -r '.target_command | length')"
{
  printf 'approval=%s\n' "$approval"
  printf 'exec_seen=%s\n' "$exec_seen"
  printf 'disable_hooks=%s\n' "$disable_hooks"
  printf 'sandbox=%s\n' "$sandbox"
  printf 'schema=%s\n' "$schema"
  printf 'command_length=%s\n' "$command_length"
} > "$cd_arg/fake-codex.args"

branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
command="$(printf '%s' "$command_json_line" | jq -r '.target_command')"
diff_hash="$(git -C "$cd_arg" diff --cached --no-ext-diff | shasum -a 256 | awk '{print $1}')"
command_hash="$(printf '%s' "$command" | shasum -a 256 | awk '{print $1}')"
commit_subject="$(printf '%s' "$command" | sed -n "s/.* -m '\([^']*\)'.*/\1/p" | head -1)"
commit_subject_hash="$(printf '%s' "$commit_subject" | shasum -a 256 | awk '{print $1}')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" --arg csh "$commit_subject_hash" \
  '{branch:$b, head:$h, command_kind:"commit", diff_hash:$dh, command_hash:$ch, commit_subject_hash:$csh, verdict:"PASS", findings:[]}' \
  > "$output"
FAKE_CODEX
chmod +x "$AGENTIC_REPO/bin/codex"

out="$(printf '{"tool_input":{"command":"git commit -m '\''test(hooks): codex audit'\''"}}' \
      | ( cd "$AGENTIC_REPO" && CLAUDE_PROJECT_DIR="$AGENTIC_REPO" CODEX_SANDBOX=seatbelt CODEX_BIN="$AGENTIC_REPO/bin/codex" bash "$AGENTIC_REPO/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
check_agentic=yes
[[ -z "$out" ]] || check_agentic=no
[[ ! -e "$AGENTIC_REPO/.claude/.last-audit.json" ]] || check_agentic=no
grep -q '^approval=never$' "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
grep -q '^exec_seen=yes$' "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
grep -q '^disable_hooks=yes$' "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
grep -q '^sandbox=read-only$' "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
grep -q 'commit-push-audit.schema.json$' "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
expected_agentic_command="git commit -m 'test(hooks): codex audit'"
grep -q "^command_length=${#expected_agentic_command}$" "$AGENTIC_REPO/fake-codex.args" || check_agentic=no
grep -q 'Spawn subagents' "$AGENTIC_REPO/prompt.txt" || check_agentic=no
grep -q 'short-secret' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'short secret with spaces' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'single quoted secret' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'dbpass' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'urlpass' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'raw-query-key' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q 'raw-client-value' "$AGENTIC_REPO/prompt.txt" && check_agentic=no
grep -q '<redacted-secret-assignment>' "$AGENTIC_REPO/prompt.txt" || check_agentic=no
grep -q '<redacted-url-credentials>@' "$AGENTIC_REPO/prompt.txt" || check_agentic=no
grep -q '<redacted-query-secret>' "$AGENTIC_REPO/prompt.txt" || check_agentic=no
if [[ "$check_agentic" == "yes" ]]; then
  pass=$((pass + 1))
  printf '  PASS  Codex preflight agentic audit uses codex exec contract\n'
else
  fail=$((fail + 1))
  printf '  FAIL  Codex preflight agentic audit uses codex exec contract  (out=%s checks=%s)\n' "${out:-EMPTY}" "$check_agentic"
fi
rm -rf "$AGENTIC_REPO"

echo
echo "## Codex: malformed agentic audit output fails closed"
BAD_REPO="$(mktemp -d)"
git -C "$BAD_REPO" init -q
git -C "$BAD_REPO" config user.email t@t.test
git -C "$BAD_REPO" config user.name tester
mkdir -p "$BAD_REPO/.claude/hooks" "$BAD_REPO/bin"
cp "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
   "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
   "$BAD_REPO/.claude/hooks/"
printf 'base\n' > "$BAD_REPO/f"
git -C "$BAD_REPO" add -A
git -C "$BAD_REPO" commit -qm base
printf 'change\n' >> "$BAD_REPO/f"
git -C "$BAD_REPO" add -A
cat > "$BAD_REPO/bin/codex" <<'BAD_FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi

cd_arg=""; output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) cat >/dev/null; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done

jq -nc '{branch:1, verdict:"PASS", findings:"not an array"}' > "$output"
BAD_FAKE_CODEX
chmod +x "$BAD_REPO/bin/codex"

( cd "$BAD_REPO" && CLAUDE_PROJECT_DIR="$BAD_REPO" CODEX_BIN="$BAD_REPO/bin/codex" CODEX_COMMIT_PUSH_AUDIT_MODE=agentic bash "$BAD_REPO/.claude/hooks/run-commit-push-audit.sh" commit "git commit -m 'test(hooks): reject bad audit'" >/dev/null 2>"$BAD_REPO/err.txt" )
bad_rc=$?
bad_verdict="$(jq -r '.verdict' "$BAD_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
bad_finding="$(jq -r '.findings[0] // ""' "$BAD_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
if [[ "$bad_rc" != 0 && "$bad_verdict" == "FAIL" && "$bad_finding" == *"malformed JSON"* ]]; then
  pass=$((pass + 1))
  printf '  PASS  malformed Codex audit output fails closed\n'
else
  fail=$((fail + 1))
  printf '  FAIL  malformed Codex audit output fails closed  (rc=%s verdict=%s finding=%s)\n' "$bad_rc" "$bad_verdict" "$bad_finding"
fi
rm -rf "$BAD_REPO"

echo
echo "## Codex: private key diffs fail before agentic prompt"
KEY_REPO="$(mktemp -d)"
git -C "$KEY_REPO" init -q
git -C "$KEY_REPO" config user.email t@t.test
git -C "$KEY_REPO" config user.name tester
mkdir -p "$KEY_REPO/.claude/hooks"
cp "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
   "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
   "$KEY_REPO/.claude/hooks/"
printf 'base\n' > "$KEY_REPO/f"
git -C "$KEY_REPO" add -A
git -C "$KEY_REPO" commit -qm base
key_begin='-----BEGIN OPENSSH '
key_begin+='PRIVATE KEY-----'
key_end='-----END OPENSSH '
key_end+='PRIVATE KEY-----'
{
  printf '%s\n' "$key_begin"
  printf '%s\n' 'short-body-line'
  printf '%s\n' "$key_end"
} > "$KEY_REPO/key.pem"
git -C "$KEY_REPO" add -A
( cd "$KEY_REPO" && CLAUDE_PROJECT_DIR="$KEY_REPO" CODEX_COMMIT_PUSH_AUDIT_MODE=agentic bash "$KEY_REPO/.claude/hooks/run-commit-push-audit.sh" commit "git commit -m 'test(hooks): reject private key'" >/dev/null 2>"$KEY_REPO/err.txt" )
key_rc=$?
key_verdict="$(jq -r '.verdict' "$KEY_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
key_finding="$(jq -r '.findings[0] // ""' "$KEY_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
if [[ "$key_rc" != 0 && "$key_verdict" == "FAIL" && "$key_finding" == *"secret-like token"* ]]; then
  pass=$((pass + 1))
  printf '  PASS  private key diff fails local precheck\n'
else
  fail=$((fail + 1))
  printf '  FAIL  private key diff fails local precheck  (rc=%s verdict=%s finding=%s)\n' "$key_rc" "$key_verdict" "$key_finding"
fi
rm -rf "$KEY_REPO"

AUTH_REPO="$(mktemp -d)"
git -C "$AUTH_REPO" init -q
git -C "$AUTH_REPO" config user.email t@t.test
git -C "$AUTH_REPO" config user.name tester
mkdir -p "$AUTH_REPO/.claude/hooks"
cp "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
   "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
   "$AUTH_REPO/.claude/hooks/"
printf 'base\n' > "$AUTH_REPO/f"
git -C "$AUTH_REPO" add -A
git -C "$AUTH_REPO" commit -qm base
aws_key='AKIA'
aws_key+='ABCDEFGHIJKLMNOP'
bearer='Bearer '
bearer+='rawbearervalue123'
{
  printf 'aws=%s\n' "$aws_key"
  printf 'Authorization: %s\n' "$bearer"
} > "$AUTH_REPO/auth.txt"
git -C "$AUTH_REPO" add -A
( cd "$AUTH_REPO" && CLAUDE_PROJECT_DIR="$AUTH_REPO" CODEX_COMMIT_PUSH_AUDIT_MODE=agentic bash "$AUTH_REPO/.claude/hooks/run-commit-push-audit.sh" commit "git commit -m 'test(hooks): reject auth secret'" >/dev/null 2>"$AUTH_REPO/err.txt" )
auth_rc=$?
auth_verdict="$(jq -r '.verdict' "$AUTH_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
auth_finding="$(jq -r '.findings[0] // ""' "$AUTH_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
if [[ "$auth_rc" != 0 && "$auth_verdict" == "FAIL" && "$auth_finding" == *"secret-like token"* ]]; then
  pass=$((pass + 1))
  printf '  PASS  auth credential diff fails local precheck\n'
else
  fail=$((fail + 1))
  printf '  FAIL  auth credential diff fails local precheck  (rc=%s verdict=%s finding=%s)\n' "$auth_rc" "$auth_verdict" "$auth_finding"
fi
rm -rf "$AUTH_REPO"

echo
echo "## Codex: non-synthetic push audit fails closed"
PUSH_REPO="$(mktemp -d)"
PUSH_REMOTE="$(mktemp -d)"
git -C "$PUSH_REPO" init -q
git -C "$PUSH_REPO" config user.email t@t.test
git -C "$PUSH_REPO" config user.name tester
git -C "$PUSH_REPO" branch -M main
git init -q --bare "$PUSH_REMOTE"
git -C "$PUSH_REPO" remote add origin "$PUSH_REMOTE"
mkdir -p "$PUSH_REPO/.claude/hooks" "$PUSH_REPO/bin"
cp "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
   "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
   "$PUSH_REPO/.claude/hooks/"
printf 'base\n' > "$PUSH_REPO/f"
git -C "$PUSH_REPO" add -A
git -C "$PUSH_REPO" commit -qm "test(hooks): seed push repo"
git -C "$PUSH_REPO" push -q origin main
printf 'change\n' >> "$PUSH_REPO/f"
git -C "$PUSH_REPO" add -A
git -C "$PUSH_REPO" commit -qm "test(hooks): exercise push audit"
( cd "$PUSH_REPO" && CLAUDE_PROJECT_DIR="$PUSH_REPO" CODEX_COMMIT_PUSH_AUDIT_MODE=agentic bash "$PUSH_REPO/.claude/hooks/run-commit-push-audit.sh" push "git push origin main" >/dev/null 2>"$PUSH_REPO/err.txt" )
push_rc=$?
push_verdict="$(jq -r '.verdict' "$PUSH_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
push_kind="$(jq -r '.command_kind' "$PUSH_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
push_finding="$(jq -r '.findings[0] // ""' "$PUSH_REPO/.claude/.last-audit.json" 2>/dev/null || echo missing)"
if [[ "$push_rc" != 0 && "$push_verdict" == "FAIL" && "$push_kind" == "push" && "$push_finding" == *"synthetic pre-push command"* ]]; then
  pass=$((pass + 1))
  printf '  PASS  non-synthetic push audit fails closed\n'
else
  fail=$((fail + 1))
  printf '  FAIL  non-synthetic push audit fails closed  (rc=%s verdict=%s kind=%s finding=%s)\n' "$push_rc" "$push_verdict" "$push_kind" "$push_finding"
fi
rm -rf "$PUSH_REPO" "$PUSH_REMOTE"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
