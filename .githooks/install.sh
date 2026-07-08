#!/usr/bin/env bash
# Point this clone's git hooks at .githooks/ — the agent-agnostic gate layer.
# Per-clone config (run once per clone/worktree checkout):
#   bash .githooks/install.sh
# The framework-managed hooks in .git/hooks (prek fmt/lint, test matrix) keep
# running: .githooks/* chain to them after the gate.
set -euo pipefail
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks (agent-agnostic gate active; framework hooks chained)"
