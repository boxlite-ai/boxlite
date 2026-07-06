#!/usr/bin/env bash
# Harness-neutral verdict-audit runner: any coding agent that can run bash gets an
# INDEPENDENT auditor — the same cold-reader judgment Claude Code gets from its
# verdict-auditor subagent — instead of degrading to self-audit.
#
#   bash .claude/hooks/run-verdict-audit.sh <transcript_path>
#
# Feeds the procedure in .claude/agents/verdict-auditor.md (frontmatter stripped)
# as the system prompt to a model CLI with Read/Bash/Write tools, which audits the
# transcript's last assistant message against the working tree and writes the
# dossier (.claude/.last-verdict.json). Succeeds only if the dossier lands.
#
# Model resolution (same seam pattern as the triage classifier):
#   1. VERDICT_AUDITOR_CMD — full override; invoked with the audit prompt on stdin;
#      must leave a dossier behind. Per-harness config, tests stub it.
#   2. claude CLI — headless with the auditor spec as system prompt, tools
#      whitelisted, hooks disabled (no nested gates), 10-minute cap.
#   3. Neither → exit 2 with instructions (the caller sees why).
#
# Exit codes: 0 dossier written · 1 audit ran but no dossier · 2 no runner available.
set -uo pipefail

transcript_path="${1:-}"
if [[ -z "$transcript_path" ]]; then
  echo "usage: run-verdict-audit.sh <transcript_path>" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
project_dir="${CLAUDE_PROJECT_DIR:-$repo_root}"
spec_file="$project_dir/.claude/agents/verdict-auditor.md"
verdict_file="$project_dir/.claude/.last-verdict.json"
audit_timeout_seconds="${VERDICT_AUDITOR_TIMEOUT:-600}"
auditor_model="${VERDICT_AUDITOR_MODEL:-claude-sonnet-5}"

audit_prompt="Audit the last assistant message in the session transcript: each claim
it presents as established must have concrete, direct proof in the evidence — the
working-tree diff, the commands and their output in the transcript, or cited
files/logs. A claim backed only by guessing or indirect inference is NOT proven. A
turn that asserts nothing verifiable is a PASS. Follow your procedure and write the
dossier to ${verdict_file}. transcript_path: ${transcript_path}"

# The audit must be attributable to a fresh run, not a leftover dossier.
before_mtime="$(stat -f '%m' "$verdict_file" 2>/dev/null || stat -c '%Y' "$verdict_file" 2>/dev/null || echo 0)"

if [[ -n "${VERDICT_AUDITOR_CMD:-}" ]]; then
  printf '%s' "$audit_prompt" | bash -c "$VERDICT_AUDITOR_CMD" || true
elif command -v claude >/dev/null 2>&1 && [[ -r "$spec_file" ]]; then
  # Frontmatter (--- ... ---) is subagent wiring, not instructions — strip it.
  spec_body="$(awk 'BEGIN{fm=0} NR==1 && /^---$/{fm=1; next} fm==1 && /^---$/{fm=2; next} fm!=1' "$spec_file")"
  # perl alarm = portable timeout; disableAllHooks so the audit run cannot recurse
  # into this repo's own gates.
  printf '%s' "$audit_prompt" \
    | perl -e 'alarm shift; exec @ARGV' "$audit_timeout_seconds" \
        claude -p --model "$auditor_model" \
          --append-system-prompt "$spec_body" \
          --allowedTools "Read" "Bash" "Write" \
          --settings '{"disableAllHooks":true}' \
    || true
else
  cat >&2 <<'EOF'
run-verdict-audit.sh: no auditor runner available.
Set VERDICT_AUDITOR_CMD (stdin = audit prompt; must write .claude/.last-verdict.json)
or install the claude CLI. As a last resort, execute the procedure in
.claude/agents/verdict-auditor.md with any capable model and have IT write the dossier.
EOF
  exit 2
fi

after_mtime="$(stat -f '%m' "$verdict_file" 2>/dev/null || stat -c '%Y' "$verdict_file" 2>/dev/null || echo 0)"
if [[ -r "$verdict_file" && "$after_mtime" != "$before_mtime" ]] \
   && jq -e '.verdict and .branch and .tree_hash' "$verdict_file" >/dev/null 2>&1; then
  echo "audit complete: $(jq -r '.verdict' "$verdict_file") → $verdict_file"
  exit 0
fi

echo "run-verdict-audit.sh: audit ran but no fresh dossier was written to $verdict_file" >&2
exit 1
