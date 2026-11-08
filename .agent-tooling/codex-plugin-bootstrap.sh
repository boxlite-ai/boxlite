#!/usr/bin/env bash
# Stable consumer loader. Release and host policy live in the adopted package.
set -euo pipefail
repo_root="$(git -C "$PWD" rev-parse --show-toplevel)"
common="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
runtime_path() {
  local revision
  [[ -f "$common/agent-tooling/current" ]] || return 1
  revision="$(head -n1 "$common/agent-tooling/current")"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  runtime="$common/agent-tooling/$revision/plugins/boxlite-agent-tooling/scripts/codex-plugin-bootstrap.sh"
  [[ -r "$runtime" ]]
}
if ! runtime_path; then
  command -v codex >/dev/null || { printf 'agent-tooling: Codex CLI is required\n' >&2; exit 1; }
  if ! (cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 bash .agent-tooling/install.sh </dev/null) >&2; then
    printf 'agent-tooling: automatic tooling installation failed\n' >&2
    exit 1
  fi
  runtime_path || { printf 'agent-tooling: bootstrap requires tooling 0.1.35 or newer; keep the matching bootstrap for an older hold\n' >&2; exit 1; }
fi
exec bash "$runtime" "$@"
