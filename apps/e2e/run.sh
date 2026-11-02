#!/usr/bin/env bash
# The Make targets and direct invocation share one lifecycle owner.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/manage.py" run -- "$@"
