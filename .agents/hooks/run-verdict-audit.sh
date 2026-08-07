#!/usr/bin/env bash
# Harness-neutral verdict-audit runner: any coding agent that can run bash gets an
# INDEPENDENT auditor — the same cold-reader judgment Claude Code gets from its
# verdict-auditor subagent — instead of degrading to self-audit.
#
#   bash .agents/hooks/run-verdict-audit.sh <transcript_path>
#
# Feeds the procedure in .claude/agents/verdict-auditor.md (frontmatter stripped)
# as the system prompt to a model CLI with Read/Bash/Write tools, which audits the
# transcript's final turn (all assistant text since the last real user message,
# mid-turn claims included) against the working tree and writes the
# dossier (.agents/state/last-verdict.json). Succeeds only if the dossier lands.
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
verdict_file="$project_dir/.agents/state/last-verdict.json"
audit_lock_file="$project_dir/.agents/state/verdict-audit.lock"
audit_timeout_seconds="${VERDICT_AUDITOR_TIMEOUT:-600}"
auditor_model="${VERDICT_AUDITOR_MODEL:-claude-sonnet-5}"

# Announce "an audit is running" to preflight-verdict-check.sh, which otherwise re-blocks
# the agent every few seconds for this script's whole runtime. Taken before either runner
# branch so the no-runner exit 2 clears it on the way out.
# The printf below is the ONLY definition of the body format; other sites point here.
# This script writes the deadline because only it knows VERDICT_AUDITOR_TIMEOUT; slack
# covers teardown after the alarm. The `|| return 0` swallows keep the lock an
# optimisation, never a precondition — an unwritable state dir must still audit.
take_audit_lock() {
  mkdir -p "$(dirname "$audit_lock_file")" 2>/dev/null || return 0
  printf '%s %s' "$$" "$(( $(date +%s) + audit_timeout_seconds + 60 ))" \
    > "$audit_lock_file" 2>/dev/null || return 0
  trap 'rm -f "$audit_lock_file"' EXIT INT TERM
}
take_audit_lock

# Frontmatter (--- ... ---) is subagent WIRING — name, tools, and now the model and
# reasoning effort the Task path launches with. None of it is instruction, so none of it
# may reach the model as part of the procedure. Named rather than inlined at the call
# site because that call site sits in the claude-CLI branch, which the suite can only
# enter by faking `claude` on PATH; as an inline awk this parse had zero coverage while
# quietly deciding what the auditor is told.
strip_frontmatter() {  # $1 = spec file
  awk 'BEGIN{fm=0} NR==1 && /^---$/{fm=1; next} fm==1 && /^---$/{fm=2; next} fm!=1' "$1"
}

audit_prompt="Audit the final turn in the session transcript — every assistant
message since the last real user message: each claim
it presents as established must have concrete, direct proof in the evidence — the
working-tree diff, the commands and their output in the transcript, or cited
files/logs. A claim backed only by guessing or indirect inference is NOT proven. A
turn that asserts nothing verifiable is a PASS. Follow your procedure and write the
dossier to ${verdict_file}. transcript_path: ${transcript_path}"

# The audit must be attributable to a fresh run, not a leftover dossier, so each
# runner removes any existing one first and EXISTENCE alone then proves freshness.
# Comparing mtimes instead cannot: they are whole seconds, so an auditor that
# rewrites the dossier within the same second looks unchanged and a genuine run is
# rejected. The removal sits inside each branch, not above them: the no-runner path
# below exits 2 without auditing, and must not destroy a dossier on its way out.
if [[ -n "${VERDICT_AUDITOR_CMD:-}" ]]; then
  rm -f "$verdict_file"
  printf '%s' "$audit_prompt" | bash -c "$VERDICT_AUDITOR_CMD" || true
elif command -v claude >/dev/null 2>&1 && [[ -r "$spec_file" ]]; then
  rm -f "$verdict_file"
  spec_body="$(strip_frontmatter "$spec_file")"
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
Set VERDICT_AUDITOR_CMD (stdin = audit prompt; must write .agents/state/last-verdict.json)
or install the claude CLI. As a last resort, execute the procedure in
.claude/agents/verdict-auditor.md with any capable model and have IT write the dossier.
EOF
  exit 2
fi

if [[ -r "$verdict_file" ]] \
   && jq -e '.verdict and .branch and .tree_hash' "$verdict_file" >/dev/null 2>&1; then
  echo "audit complete: $(jq -r '.verdict' "$verdict_file") → $verdict_file"
  exit 0
fi

echo "run-verdict-audit.sh: audit ran but no fresh dossier was written to $verdict_file" >&2
exit 1
