#!/usr/bin/env bash
# Local, deterministic commit/push audit used by non-Claude harnesses.
#
# This does not replace the richer Claude Code `commit-push-auditor` subagent;
# it gives Codex a no-network way to produce the same .last-audit.json contract
# for straightforward commits where the command line exposes the commit message.
set -uo pipefail

kind="${1:-}"
command="${2:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
audit_file="$project_dir/.claude/.last-audit.json"
mkdir -p "$(dirname "$audit_file")"

branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || echo '?')"
head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo '?')"
findings=()

add_finding() {
  findings+=("$1")
}

extract_commit_subject() {
  local cmd="$1"
  case "$cmd" in
    *" -m '"*)
      printf '%s' "$cmd" | sed -n "s/.* -m '\([^']*\)'.*/\1/p" | head -1
      ;;
    *' -m "'*)
      printf '%s' "$cmd" | sed -n 's/.* -m "\([^"]*\)".*/\1/p' | head -1
      ;;
    *" --message '"*)
      printf '%s' "$cmd" | sed -n "s/.* --message '\([^']*\)'.*/\1/p" | head -1
      ;;
    *' --message "'*)
      printf '%s' "$cmd" | sed -n 's/.* --message "\([^"]*\)".*/\1/p' | head -1
      ;;
    *)
      printf ''
      ;;
  esac
}

check_subject() {
  local subject="$1" context="$2"
  local conventional='^[a-z]+(\([^)]+\))?:[[:space:]][^[:space:]].+'
  if [[ -z "$subject" ]]; then
    add_finding "$context: commit subject unavailable to local audit; use -m/--message or audit at push"
    return
  fi
  if (( ${#subject} > 72 )); then
    add_finding "$context: subject exceeds 72 characters"
  fi
  if [[ ! "$subject" =~ $conventional ]]; then
    add_finding "$context: subject is not Conventional Commit format"
  fi
}

check_diff_text() {
  local diff="$1"
  local openai_live_pattern="sk-"
  openai_live_pattern+="live"
  local slack_pattern="xox"
  slack_pattern+="[baprs]-"
  local github_pattern="ghp"
  github_pattern+="_[A-Za-z0-9_]{20,}"
  local private_key_pattern="-{5}BEGIN (RSA |EC |OPENSSH |PRIVATE )?PRIVATE "
  private_key_pattern+="KEY-{5}"
  local secret_pattern="(${openai_live_pattern}|${slack_pattern}|${github_pattern}|${private_key_pattern})"
  if [[ -z "$diff" ]]; then
    add_finding "Verify: no diff found for ${kind}"
    return
  fi
  if printf '%s' "$diff" | grep -qE "(^|\\+).*${secret_pattern}"; then
    add_finding "Security: diff appears to contain a secret-like token"
  fi
  if printf '%s' "$diff" | grep -q '\.pr-reviewed\.json'; then
    add_finding "Cross-cutting: PR review gate marker must not be committed"
  fi
}

case "$kind" in
  commit)
    diff_text="$(git -C "$repo_root" diff --cached --no-ext-diff)"
    check_diff_text "$diff_text"
    check_subject "$(extract_commit_subject "$command")" "Commit"
    ;;
  push)
    diff_text="$(git -C "$repo_root" diff --no-ext-diff origin/main...HEAD 2>/dev/null || git -C "$repo_root" diff --no-ext-diff HEAD~1...HEAD)"
    check_diff_text "$diff_text"
    while IFS= read -r subject; do
      check_subject "$subject" "Push"
    done < <(git -C "$repo_root" log origin/main..HEAD --format=%s 2>/dev/null || git -C "$repo_root" log -1 --format=%s)
    ;;
  *)
    add_finding "Internal: unknown command kind '${kind}'"
    ;;
esac

verdict="PASS"
if (( ${#findings[@]} > 0 )); then
  verdict="FAIL"
fi

if (( ${#findings[@]} == 0 )); then
  findings_json="[]"
else
  findings_json="$(printf '%s\n' "${findings[@]}" | jq -R . | jq -s .)"
fi
jq -nc \
  --arg branch "$branch" \
  --arg head "$head" \
  --arg command_kind "$kind" \
  --arg verdict "$verdict" \
  --argjson findings "$findings_json" \
  '{branch:$branch, head:$head, command_kind:$command_kind, verdict:$verdict, findings:$findings}' \
  > "$audit_file"

printf 'local audit %s: %s\n' "$kind" "$verdict"
if [[ "$verdict" == "FAIL" ]]; then
  printf '%s\n' "${findings[@]}" >&2
  exit 1
fi
