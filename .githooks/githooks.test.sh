#!/usr/bin/env bash
# Tests for the agent-agnostic git-hook gate layer (.githooks/pre-commit,
# .githooks/pre-push) and the PreToolUse delegation guard in
# .claude/hooks/preflight-commit-push.sh.
#
# Contract under test:
#   - agent marker present (CLAUDECODE / CODEX_SANDBOX / AGENT_GATED) + no audit -> commit/push rejected
#   - agent marker + fresh matching PASS audit                              -> allowed, audit consumed
#   - no agent marker (human)                                              -> allowed, ungated
#   - framework hook in .git/hooks is chained after the gate (prek keeps running)
#   - PreToolUse script defers when core.hooksPath -> .githooks (single consumer),
#     EXCEPT when called BY the git-level gate (GITHOOK_DELEGATED)
#
# Run with:  bash .githooks/githooks.test.sh
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

pass=0
fail=0

check_eq() {  # desc  got  want
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s want=%s)\n' "$desc" "$got" "$want"
  fi
}

hash_stdin() {
  shasum -a 256 | awk '{print $1}'
}

diff_hash_for() {
  local repo="$1" kind="$2"
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
  local subject="$1"
  if [[ -n "$subject" ]]; then
    printf '%s' "$subject" | hash_stdin
  fi
}

zero_sha() {
  printf '%040d' 0
}

current_branch_ref() {
  local repo="$1"
  printf 'refs/heads/%s' "$(git -C "$repo" branch --show-current)"
}

write_ref_updates_file() {  # repo remote local_ref remote_ref output_file
  local repo="$1" remote="$2" local_ref="$3" remote_ref="$4" output_file="$5"
  local local_sha remote_sha
  local_sha="$(git -C "$repo" rev-parse "$local_ref")"
  remote_sha="$(git -C "$repo" ls-remote "$remote" "$remote_ref" | awk 'NR == 1 {print $1}')"
  [[ -n "$remote_sha" ]] || remote_sha="$(zero_sha)"
  printf '%s %s %s %s\n' "$local_ref" "$local_sha" "$remote_ref" "$remote_sha" > "$output_file"
}

pushed_diff_hash_for() {  # repo remote ref_updates_file
  local repo="$1" remote="$2" ref_updates_file="$3"
  local empty_tree local_ref local_sha remote_ref remote_sha base_sha candidate
  empty_tree="$(git -C "$repo" hash-object -t tree /dev/null)"
  while read -r local_ref local_sha remote_ref remote_sha; do
    [[ -n "${local_ref:-}" ]] || continue
    printf '## ref-update %s %s %s %s\n' "$local_ref" "$local_sha" "$remote_ref" "$remote_sha"
    if [[ "$local_sha" =~ ^0+$ ]]; then
      printf 'deleted %s at %s\n' "$remote_ref" "$remote_sha"
    elif [[ "$remote_sha" =~ ^0+$ ]]; then
      base_sha=""
      while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        if git -C "$repo" merge-base --is-ancestor "$candidate" "$local_sha" 2>/dev/null; then
          base_sha="$candidate"
          break
        fi
      done < <(git -C "$repo" for-each-ref --format='%(objectname)' "refs/remotes/${remote}" 2>/dev/null)
      if [[ -n "$base_sha" ]]; then
        git -C "$repo" log --format='commit-subject %H %s' "$base_sha..$local_sha" 2>/dev/null || true
        git -C "$repo" diff --no-ext-diff "$base_sha" "$local_sha" 2>/dev/null || true
      else
        git -C "$repo" log --format='commit-subject %H %s' "$local_sha" || true
        git -C "$repo" diff --no-ext-diff "$empty_tree" "$local_sha" || true
      fi
    else
      git -C "$repo" log --format='commit-subject %H %s' "$remote_sha..$local_sha" 2>/dev/null || true
      git -C "$repo" diff --no-ext-diff "$remote_sha" "$local_sha" 2>/dev/null || true
    fi
  done < "$ref_updates_file" | hash_stdin
}

pre_push_command_for() {  # repo remote local_ref remote_ref
  local repo="$1" remote="$2" local_ref="$3" remote_ref="$4"
  local remote_url remote_url_hash ref_updates_file ref_updates_hash pushed_diff_hash
  remote_url="$(git -C "$repo" remote get-url "$remote" 2>/dev/null || printf '')"
  remote_url_hash="$(printf '%s' "$remote_url" | hash_stdin)"
  ref_updates_file="$(mktemp)"
  write_ref_updates_file "$repo" "$remote" "$local_ref" "$remote_ref" "$ref_updates_file"
  ref_updates_hash="$(shasum -a 256 "$ref_updates_file" | awk '{print $1}')"
  pushed_diff_hash="$(pushed_diff_hash_for "$repo" "$remote" "$ref_updates_file")"
  rm -f "$ref_updates_file"
  printf 'git push --pre-push-hook remote=%s remote_url_sha256=%s ref_updates_sha256=%s pushed_diff_sha256=%s' \
    "$remote" "$remote_url_hash" "$ref_updates_hash" "$pushed_diff_hash"
}

# Fixture repo with the real gate scripts copied in and hooksPath pointed at
# its own .githooks (absolute, so hook execution is location-independent).
setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  mkdir -p "$d/.githooks" "$d/.claude/hooks"
  cp "$REPO_ROOT/.githooks/pre-commit" "$REPO_ROOT/.githooks/pre-push" "$REPO_ROOT/.githooks/commit-msg" "$d/.githooks/"
  cp "$REPO_ROOT/.claude/hooks/preflight-commit-push.sh" \
     "$REPO_ROOT/.claude/hooks/run-commit-push-audit.sh" \
     "$REPO_ROOT/.claude/hooks/commit-push-audit.schema.json" \
     "$d/.claude/hooks/"
  printf 'x\n' > "$d/f"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  git -C "$d" config core.hooksPath "$d/.githooks"
  printf '%s' "$d"
}

# Fresh PASS audit bound to the fixture's current state.
write_audit() {  # repo kind [push_local_ref push_remote_ref]
  local repo="$1" kind="$2" br hd command subject local_ref remote_ref diff_hash
  br="$(git -C "$repo" branch --show-current)"; hd="$(git -C "$repo" rev-parse HEAD)"
  diff_hash="$(diff_hash_for "$repo" "$kind")"
  case "$kind" in
    commit) command="git commit -m change"; subject="change" ;;
    push)
      local_ref="${3:-$(current_branch_ref "$repo")}"
      remote_ref="${4:-$local_ref}"
      command="$(pre_push_command_for "$repo" origin "$local_ref" "$remote_ref")"
      diff_hash="${command##* pushed_diff_sha256=}"
      subject=""
      ;;
    *) command="git ${kind}"; subject="" ;;
  esac
  jq -nc --arg b "$br" --arg h "$hd" --arg k "$kind" \
    --arg dh "$diff_hash" \
    --arg ch "$(command_hash_for "$command")" \
    --arg csh "$(subject_hash_for "$subject")" \
    '{branch:$b, head:$h, command_kind:$k, diff_hash:$dh, command_hash:$ch, commit_subject_hash:$csh, verdict:"PASS", findings:[]}' \
    > "$repo/.claude/.last-audit.json"
}

write_handoff_audit() {  # repo kind command
  local repo="$1" kind="$2" command="$3" br hd dh ch
  br="$(git -C "$repo" branch --show-current)"; hd="$(git -C "$repo" rev-parse HEAD)"
  dh="$(diff_hash_for "$repo" "$kind")"
  ch="$(command_hash_for "$command")"
  jq -nc --arg b "$br" --arg h "$hd" --arg k "$kind" \
    --arg dh "$dh" --arg ch "$ch" \
    '{branch:$b, head:$h, command_kind:$k, diff_hash:$dh, command_hash:$ch, commit_subject_hash:"", verdict:"PASS", findings:[]}' \
    > "$repo/.claude/.last-audit.json"
  jq -nc --arg b "$br" --arg h "$hd" --arg k "$kind" \
    --arg dh "$dh" --arg ch "$ch" \
    '{branch:$b, head:$h, command_kind:$k, diff_hash:$dh, command_hash:$ch}' \
    > "$repo/.claude/.last-audit-handoff.json"
}

stage_change() {
  local repo="$1"
  printf 'y\n' >> "$repo/f"; git -C "$repo" add -A
}

# Run `git commit` in the fixture as agent or human; echo the exit code.
# env -i gives a hermetic environment: the ambient session's own harness markers
# (CLAUDECODE, CLAUDE_PROJECT_DIR, plugin CODEX_COMPANION_*) must not leak into
# the fixture's gate decision.
run_commit() {  # repo  agent|human [message]
  local repo="$1" who="$2" message="${3:-change}"
  if [[ "$who" == "agent" ]]; then
    ( cd "$repo" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git commit -qm "$message" >/dev/null 2>"$repo/err.txt" )
  else
    ( cd "$repo" && env -i PATH="$PATH" HOME="$HOME" git commit -qm "$message" >/dev/null 2>"$repo/err.txt" )
  fi
  echo $?
}

write_broken_preflight() {  # repo exit|invalid
  local repo="$1" mode="$2"
  case "$mode" in
    exit)
      cat > "$repo/.claude/hooks/preflight-commit-push.sh" <<'BROKEN_PREFLIGHT'
#!/usr/bin/env bash
printf 'boom from delegated preflight\n' >&2
exit 7
BROKEN_PREFLIGHT
      ;;
    invalid)
      cat > "$repo/.claude/hooks/preflight-commit-push.sh" <<'BROKEN_PREFLIGHT'
#!/usr/bin/env bash
printf 'not-json\n'
BROKEN_PREFLIGHT
      ;;
  esac
  chmod +x "$repo/.claude/hooks/preflight-commit-push.sh"
}

try_commit() {  # repo  agent|human
  local repo="$1" who="$2"
  stage_change "$repo"
  run_commit "$repo" "$who"
}

grep -q 'last-push-audit-context.diff' "$REPO_ROOT/.claude/agents/commit-push-auditor.md" && auditor_exact=yes || auditor_exact=no
check_eq "commit-push auditor prompt uses exact push context" "$auditor_exact" "yes"
grep -q 'git log origin/main..HEAD' "$REPO_ROOT/.claude/agents/commit-push-auditor.md" && auditor_broad=yes || auditor_broad=no
check_eq "commit-push auditor prompt omits broad push subject range" "$auditor_broad" "no"

echo "## pre-commit: agent gated, human exempt"
R="$(setup)"
check_eq "agent + no audit → commit rejected"       "$(try_commit "$R" agent)" 1
grep -q 'commit-push-auditor' "$R/err.txt" && names=yes || names=no
check_eq "rejection names commit-push-auditor"      "$names" "yes"
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
check_eq "agent + PASS audit → commit allowed"      "$(run_commit "$R" agent)" 0
[[ -e "$R/.claude/.last-audit.json" ]] && consumed=no || consumed=yes
check_eq "audit consumed by the git-level gate"     "$consumed" "yes"
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
check_eq "agent + audited subject mismatch → commit rejected" "$(run_commit "$R" agent other)" 1
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
jq '.commit_subject_hash=""' "$R/.claude/.last-audit.json" > "$R/.claude/x.json" \
  && mv "$R/.claude/x.json" "$R/.claude/.last-audit.json"
check_eq "agent + unaudited bad subject → commit rejected" "$(run_commit "$R" agent bad)" 1
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
jq '.commit_subject_hash=""' "$R/.claude/.last-audit.json" > "$R/.claude/x.json" \
  && mv "$R/.claude/x.json" "$R/.claude/.last-audit.json"
check_eq "agent + missing audited subject → commit rejected" "$(run_commit "$R" agent "test: good")" 1
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
hooks_dir="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$hooks_dir"
printf '#!/bin/sh\nprintf "bad: rewritten by chained hook\\n" > "$1"\n' > "$hooks_dir/commit-msg"
chmod +x "$hooks_dir/commit-msg"
check_eq "agent + message rewrite after audit → commit rejected" "$(run_commit "$R" agent)" 1
grep -q 'Commit message does not match' "$R/err.txt" && guarded=yes || guarded=no
check_eq "message rewrite rejection names subject mismatch" "$guarded" "yes"
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_audit "$R" commit
hooks_dir="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$hooks_dir"
printf '#!/bin/sh\nprintf staged-after-audit >> "%s/f"\ngit -C "%s" add f\n' "$R" "$R" > "$hooks_dir/pre-commit"
chmod +x "$hooks_dir/pre-commit"
check_eq "agent + staged content after audit → commit rejected" "$(run_commit "$R" agent)" 1
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_broken_preflight "$R" exit
check_eq "agent + delegated preflight nonzero → commit rejected" "$(run_commit "$R" agent)" 1
grep -q 'delegated preflight failed' "$R/err.txt" && fail_closed=yes || fail_closed=no
check_eq "commit nonzero rejection names delegated preflight" "$fail_closed" "yes"
rm -rf "$R"

R="$(setup)"; stage_change "$R"; write_broken_preflight "$R" invalid
check_eq "agent + delegated preflight invalid JSON → commit rejected" "$(run_commit "$R" agent)" 1
grep -q 'invalid output' "$R/err.txt" && fail_closed=yes || fail_closed=no
check_eq "commit invalid-output rejection names invalid output" "$fail_closed" "yes"
rm -rf "$R"

R="$(setup)"
check_eq "human (no marker) → commit allowed"       "$(try_commit "$R" human)" 0
rm -rf "$R"

echo
echo "## chaining: the framework hook in .git/hooks still runs"
R="$(setup)"
# --git-common-dir: --git-path hooks would resolve through core.hooksPath and
# point back at the adapter itself (the exact recursion the adapters guard).
# Absolutize from inside the fixture — the raw output is cwd-relative (".git").
hooks_dir="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$hooks_dir"
printf '#!/bin/sh\ntouch "%s/chained.ran"\n' "$R" > "$hooks_dir/pre-commit"
chmod +x "$hooks_dir/pre-commit"
try_commit "$R" human >/dev/null
[[ -e "$R/chained.ran" ]] && chained=yes || chained=no
check_eq "chained .git/hooks/pre-commit executed"   "$chained" "yes"
rm -rf "$R"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
hooks_dir="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$hooks_dir"
printf '#!/bin/sh\ncat > "%s/pre-push.stdin"\n' "$R" > "$hooks_dir/pre-push"
chmod +x "$hooks_dir/pre-push"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
grep -q "$branch_ref" "$R/pre-push.stdin" && replayed=yes || replayed=no
check_eq "chained .git/hooks/pre-push receives stdin" "$replayed" "yes"
rm -rf "$R" "$B"

echo
echo "## pre-push: same contract at the push boundary"
R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + no audit → push rejected"         "$?" 1
grep -q 'pushed_diff_sha256=' "$R/err.txt" && synthetic_named=yes || synthetic_named=no
check_eq "push rejection names synthetic audit command" "$synthetic_named" "yes"
context_path="$(git -C "$R" rev-parse --git-path codex-audit/last-push-audit-context.diff)"
[[ "$context_path" != /* ]] && context_path="$R/$context_path"
[[ -e "$context_path" && "$context_path" != "$R/.claude/"* ]] && context_retained=yes || context_retained=no
check_eq "rejected push keeps git-private diff context" "$context_retained" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
write_audit "$R" push
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + PASS audit → push allowed"        "$?" 0
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
printf 'codex push\n' >> "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm 'test(hooks): codex delegated push audit'
mkdir -p "$R/bin"
cat > "$R/bin/codex" <<'PUSH_FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi
cd_arg=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$prompt" > "$cd_arg/push-prompt.txt"
branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
diff_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected diff hash: //p')"
command_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected command hash: //p')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" \
  '{branch:$b, head:$h, command_kind:"push", diff_hash:$dh, command_hash:$ch, commit_subject_hash:"", verdict:"PASS", findings:[]}' \
  > "$output"
PUSH_FAKE_CODEX
chmod +x "$R/bin/codex"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CODEX_SANDBOX=seatbelt CODEX_BIN="$R/bin/codex" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "Codex delegated pre-push self-audits exact ref update" "$?" 0
grep -q 'Sanitized pre-push ref-update diff' "$R/push-prompt.txt" && exact_prompt=yes || exact_prompt=no
check_eq "Codex push audit prompt uses pre-push diff context" "$exact_prompt" "yes"
grep -q 'Commit subjects in the exact pre-push ref-update context' "$R/push-prompt.txt" && exact_subjects=yes || exact_subjects=no
check_eq "Codex push audit prompt uses exact ref-update subjects" "$exact_subjects" "yes"
grep -q '"test(hooks): codex delegated push audit"' "$R/push-prompt.txt" && pushed_subject=yes || pushed_subject=no
check_eq "Codex push audit prompt includes pushed subject JSON" "$pushed_subject" "yes"
grep -q '"base"' "$R/push-prompt.txt" && base_subject=yes || base_subject=no
check_eq "Codex push audit prompt excludes already-pushed subject JSON" "$base_subject" "no"
grep -q 'Commit subjects on origin/main..HEAD' "$R/push-prompt.txt" && broad_subjects=yes || broad_subjects=no
check_eq "Codex push audit prompt omits broad branch subjects" "$broad_subjects" "no"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
git -C "$R" fetch -q origin
git -C "$R" checkout -qb new-ref-test
printf 'new ref\n' >> "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm 'test(hooks): new ref audit'
mkdir -p "$R/bin"
cat > "$R/bin/codex" <<'NEW_REF_FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi
cd_arg=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$prompt" > "$cd_arg/new-ref-prompt.txt"
branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
diff_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected diff hash: //p')"
command_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected command hash: //p')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" \
  '{branch:$b, head:$h, command_kind:"push", diff_hash:$dh, command_hash:$ch, commit_subject_hash:"", verdict:"PASS", findings:[]}' \
  > "$output"
NEW_REF_FAKE_CODEX
chmod +x "$R/bin/codex"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CODEX_SANDBOX=seatbelt CODEX_BIN="$R/bin/codex" git push -q origin "refs/heads/new-ref-test:refs/heads/new-ref-test" >/dev/null 2>"$R/err.txt" )
check_eq "Codex delegated new-ref push self-audits from remote base" "$?" 0
grep -q '+new ref' "$R/new-ref-prompt.txt" && grep -q 'commit-subject .*test(hooks): new ref audit' "$R/new-ref-prompt.txt" && ! grep -q 'commit-subject .*base' "$R/new-ref-prompt.txt" && new_ref_context=yes || new_ref_context=no
check_eq "new-ref audit excludes unchanged base history" "$new_ref_context" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
printf 'force base\n' >> "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm 'test(hooks): force base'
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
base_sha="$(git -C "$R" rev-parse HEAD)"
printf 'force rewind\n' >> "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm 'test(hooks): force rewind'
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
git -C "$R" reset -q --hard "$base_sha"
mkdir -p "$R/bin"
cat > "$R/bin/codex" <<'REWIND_FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi
cd_arg=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$prompt" > "$cd_arg/rewind-prompt.txt"
branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
diff_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected diff hash: //p')"
command_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected command hash: //p')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" \
  '{branch:$b, head:$h, command_kind:"push", diff_hash:$dh, command_hash:$ch, commit_subject_hash:"", verdict:"PASS", findings:[]}' \
  > "$output"
REWIND_FAKE_CODEX
chmod +x "$R/bin/codex"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CODEX_SANDBOX=seatbelt CODEX_BIN="$R/bin/codex" git push -q --force origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "Codex delegated force-push rewind self-audits" "$?" 0
grep -q '^-force rewind' "$R/rewind-prompt.txt" && rewind_diff=yes || rewind_diff=no
check_eq "force-push rewind audit includes reverse diff" "$rewind_diff" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
delete_ref="refs/heads/delete-me"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$delete_ref" >/dev/null 2>"$R/err.txt" )
mkdir -p "$R/bin"
cat > "$R/bin/codex" <<'DELETE_FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi
cd_arg=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$prompt" > "$cd_arg/delete-prompt.txt"
branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
diff_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected diff hash: //p')"
command_hash="$(printf '%s\n' "$prompt" | sed -n 's/^Expected command hash: //p')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" \
  '{branch:$b, head:$h, command_kind:"push", diff_hash:$dh, command_hash:$ch, commit_subject_hash:"", verdict:"PASS", findings:[]}' \
  > "$output"
DELETE_FAKE_CODEX
chmod +x "$R/bin/codex"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CODEX_SANDBOX=seatbelt CODEX_BIN="$R/bin/codex" git push -q origin ":$delete_ref" >/dev/null 2>"$R/err.txt" )
check_eq "Codex delegated delete-ref push self-audits" "$?" 0
grep -q "deleted $delete_ref" "$R/delete-prompt.txt" && delete_diff=yes || delete_diff=no
check_eq "delete-ref audit includes deletion context" "$delete_diff" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
write_audit "$R" push
jq --arg ch "$(command_hash_for "git push --different-command")" '.command_hash=$ch' \
  "$R/.claude/.last-audit.json" > "$R/.claude/x.json" \
  && mv "$R/.claude/x.json" "$R/.claude/.last-audit.json"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + push command hash mismatch → push rejected" "$?" 1
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
base_branch="$(git -C "$R" branch --show-current)"
branch_ref="$(current_branch_ref "$R")"
git -C "$R" checkout -qb audit-escape
printf 'evil\n' >> "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm 'test(hooks): alternate ref'
evil_ref="$(current_branch_ref "$R")"
git -C "$R" checkout -q "$base_branch"
write_audit "$R" push "$branch_ref" "$branch_ref"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$evil_ref:$evil_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + audited push of different ref → push rejected" "$?" 1
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; M="$(mktemp -d)"
git init -q --bare "$B"; git init -q --bare "$M"
git -C "$R" remote add origin "$B"; git -C "$R" remote add mirror "$M"
branch_ref="$(current_branch_ref "$R")"
write_handoff_audit "$R" push "git push mirror $branch_ref"
handoff_diff_hash="$(pre_push_command_for "$R" origin "$branch_ref" "$branch_ref")"
handoff_diff_hash="${handoff_diff_hash##* pushed_diff_sha256=}"
jq --arg dh "$handoff_diff_hash" '.diff_hash=$dh' "$R/.claude/.last-audit.json" > "$R/.claude/x.json" \
  && mv "$R/.claude/x.json" "$R/.claude/.last-audit.json"
jq --arg dh "$handoff_diff_hash" '.diff_hash=$dh' "$R/.claude/.last-audit-handoff.json" > "$R/.claude/x.json" \
  && mv "$R/.claude/x.json" "$R/.claude/.last-audit-handoff.json"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + push audit bound only to handoff → push rejected" "$?" 1
rm -rf "$R" "$B" "$M"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
write_broken_preflight "$R" exit
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + delegated preflight nonzero → push rejected" "$?" 1
grep -q 'delegated preflight failed' "$R/err.txt" && fail_closed=yes || fail_closed=no
check_eq "push nonzero rejection names delegated preflight" "$fail_closed" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
write_broken_preflight "$R" invalid
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" CLAUDECODE=1 git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "agent + delegated preflight invalid JSON → push rejected" "$?" 1
grep -q 'invalid output' "$R/err.txt" && fail_closed=yes || fail_closed=no
check_eq "push invalid-output rejection names invalid output" "$fail_closed" "yes"
rm -rf "$R" "$B"

R="$(setup)"
B="$(mktemp -d)"; git init -q --bare "$B"; git -C "$R" remote add origin "$B"
branch_ref="$(current_branch_ref "$R")"
( cd "$R" && env -i PATH="$PATH" HOME="$HOME" git push -q origin "$branch_ref:$branch_ref" >/dev/null 2>"$R/err.txt" )
check_eq "human → push allowed, ungated"            "$?" 0
rm -rf "$R" "$B"

echo
echo "## delegation guard: exactly one consumer of the audit artifact"
# With hooksPath installed, the PreToolUse layer must step aside (exit 0,
# no deny) even when a commit would otherwise be rejected...
R="$(setup)"
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
check_eq "PreToolUse defers when .githooks installed"  "${out:-EMPTY}" "EMPTY"
rm -rf "$R"

# Codex is different from Claude here: its PreToolUse hook must produce the
# audit artifact before deferring, then the git-level delegate consumes it.
R="$(setup)"
mkdir -p "$R/bin"
printf 'z\n' >> "$R/f"; git -C "$R" add -A
cat > "$R/bin/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex-cli fake\n'
  exit 0
fi
cd_arg=""; output=""; prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) cd_arg="$2"; shift 2 ;;
    --output-last-message|-o) output="$2"; shift 2 ;;
    -) prompt="$(cat)"; shift ;;
    --ask-for-approval|--disable|--sandbox|--output-schema) shift 2 ;;
    exec|--ephemeral) shift ;;
    *) shift ;;
  esac
done
branch="$(git -C "$cd_arg" branch --show-current)"
head="$(git -C "$cd_arg" rev-parse HEAD)"
command="$(printf '%s' "$prompt" | sed -n '/^{"target_command":/p' | jq -r '.target_command')"
diff_hash="$(git -C "$cd_arg" diff --cached --no-ext-diff | shasum -a 256 | awk '{print $1}')"
command_hash="$(printf '%s' "$command" | shasum -a 256 | awk '{print $1}')"
commit_subject="$(printf '%s' "$command" | sed -n "s/.* -m '\([^']*\)'.*/\1/p" | head -1)"
commit_subject_hash="$(printf '%s' "$commit_subject" | shasum -a 256 | awk '{print $1}')"
jq -nc --arg b "$branch" --arg h "$head" --arg dh "$diff_hash" --arg ch "$command_hash" --arg csh "$commit_subject_hash" \
  '{branch:$b, head:$h, command_kind:"commit", diff_hash:$dh, command_hash:$ch, commit_subject_hash:$csh, verdict:"PASS", findings:[]}' \
  > "$output"
FAKE_CODEX
chmod +x "$R/bin/codex"
out="$(printf '{"tool_input":{"command":"git commit -m '\''test(hooks): codex keep audit'\''"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" CODEX_SANDBOX=seatbelt CODEX_BIN="$R/bin/codex" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
[[ -e "$R/.claude/.last-audit.json" ]] && kept=yes || kept=no
[[ -e "$R/.claude/.last-audit-handoff.json" ]] && handoff=yes || handoff=no
check_eq "Codex PreToolUse validates and keeps audit for .githooks" "${out:-EMPTY}:$kept:$handoff" "EMPTY:yes:yes"
out="$(printf '{"tool_input":{"command":"git commit"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" GITHOOK_DELEGATED=1 GITHOOK_KEEP_AUDIT=1 bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
[[ -e "$R/.claude/.last-audit.json" ]] && kept_after_precommit=yes || kept_after_precommit=no
[[ -e "$R/.claude/.last-audit-handoff.json" ]] && handoff_after_precommit=yes || handoff_after_precommit=no
check_eq "delegated pre-commit keeps Codex audit for commit-msg" "${out:-EMPTY}:$kept_after_precommit:$handoff_after_precommit" "EMPTY:yes:yes"
printf 'test(hooks): codex keep audit\n' > "$R/msg.txt"
( cd "$R" && CLAUDECODE=1 "$R/.githooks/commit-msg" "$R/msg.txt" >/dev/null 2>"$R/err.txt" )
commit_msg_rc=$?
[[ -e "$R/.claude/.last-audit.json" ]] && consumed=no || consumed=yes
[[ -e "$R/.claude/.last-audit-handoff.json" ]] && handoff_consumed=no || handoff_consumed=yes
check_eq "delegated commit-msg consumes Codex audit" "$commit_msg_rc:$consumed:$handoff_consumed" "0:yes:yes"
rm -rf "$R"

R="$(setup)"
# ...but the call coming FROM the git-level gate must still be judged.
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" GITHOOK_DELEGATED=1 bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "GITHOOK_DELEGATED call still judged (deny)"  "$denied" "yes"
rm -rf "$R"

# hooksPath configured but the delegate hook ABSENT (old ref, broken install):
# git silently skips missing hooks, so deferring here would stand BOTH layers
# down — the PreToolUse layer must gate itself (fail closed).
R="$(setup)"; rm "$R/.githooks/pre-commit"
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "hooksPath set, delegate missing → fail closed (deny)" "$denied" "yes"
rm -rf "$R"

# Without hooksPath, the PreToolUse layer gates as before (no regression).
R="$(setup)"; git -C "$R" config --unset core.hooksPath
out="$(printf '{"tool_input":{"command":"git commit -m x"}}' \
      | ( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$R/.claude/hooks/preflight-commit-push.sh" ) 2>/dev/null)"
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 && denied=yes || denied=no
check_eq "no hooksPath → PreToolUse still gates"       "$denied" "yes"
rm -rf "$R"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
