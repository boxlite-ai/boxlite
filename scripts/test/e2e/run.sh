#!/usr/bin/env bash
# Entry point: bootstrap (if needed) → fixture_setup → pytest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. bootstrap — idempotent, skips on re-run if services already up
if ! systemctl is-active --quiet boxlite-api; then
    echo "── bootstrap (services not running yet) ──"
    bash "$SCRIPT_DIR/bootstrap.sh"
fi

# 2. fixture data (snapshots / quotas / p1 profile)
echo "── fixture_setup ──"
python3 "$SCRIPT_DIR/fixture_setup.py"

# 3. pip prereqs
python3 -c "import pytest, pytest_asyncio, boxlite" 2>/dev/null || \
    pip install --break-system-packages --quiet pytest pytest-asyncio boxlite

# 4. run
echo "── pytest ──"
cd "$SCRIPT_DIR"
exec python3 -m pytest cases/ -v "$@"
