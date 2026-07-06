#!/usr/bin/env bash
# UserPromptSubmit hook: snapshot the working tree at TURN START so the Stop-stage
# verdict gate (preflight-verdict-check.sh) can tell whether THIS turn changed the
# tree. That delta — not prose parsing — is what triggers a demanded audit: a turn
# that did work and ends without a dossier is blocked; a no-delta turn ends freely.
#
# Two jobs:
#   1. Write the content-addressed working-tree hash to .claude/.turn-baseline
#      (gitignored — an unignored baseline would perturb the very hash it records).
#   2. If the tree is already dirty, emit a ONE-LINE reminder on stdout. For
#      UserPromptSubmit, stdout is injected into the model's context — unlike the
#      Stop hook's systemMessage, which only the human sees. This covers the class
#      the delta trigger cannot: verdicts that change no files (pure investigation).
#
# MUST NEVER FAIL: a non-zero UserPromptSubmit hook blocks the user's prompt.
# Outside a git repo, or on any git error, exit 0 silently and write nothing.
#
# Wired in .claude/settings.json under hooks.UserPromptSubmit.
# Tests: bash .claude/hooks/turn-baseline.test.sh
set -uo pipefail

cat >/dev/null   # drain the hook payload; this hook doesn't need it

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"

# Content-addressed hash of the full working tree (tracked + untracked, full
# content), via a throwaway index. Keep IDENTICAL to the snippet in
# preflight-verdict-check.sh and verdict-auditor.md.
compute_tree_hash() {
  local idx; idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$repo_root" read-tree HEAD >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$repo_root" write-tree 2>/dev/null
  rm -f "$idx"
}

tree_hash="$(compute_tree_hash)"
[[ "$tree_hash" =~ ^[0-9a-f]{40}$ ]] || exit 0

mkdir -p "$project_dir/.claude" 2>/dev/null || exit 0
printf '%s\n' "$tree_hash" > "$project_dir/.claude/.turn-baseline" 2>/dev/null

if [[ -n "$(git -C "$repo_root" status --porcelain 2>/dev/null)" ]]; then
  printf '%s\n' "[verdict-gate] Working tree is dirty. If this turn ends by asserting a verdict (fix works / tests pass / root cause / no issues / done), invoke the verdict-auditor subagent (Task) before ending; a turn that changes files and ends without an audited dossier will be blocked."
fi

exit 0
