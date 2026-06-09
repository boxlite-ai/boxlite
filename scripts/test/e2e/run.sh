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

# 3. pip prereqs (pytest, pytest-asyncio, boxlite SDK).
python3 -c "import pytest" 2>/dev/null || \
    pip install --break-system-packages --quiet pytest
python3 -c "import pytest_asyncio" 2>/dev/null || \
    pip install --break-system-packages --quiet pytest-asyncio
python3 -c "import boxlite" 2>/dev/null || \
    pip install --break-system-packages --quiet boxlite

# 4. run — point pytest at each SDK's tests/e2e dir explicitly (paths outside
# pytest.ini's rootdir don't resolve via testpaths, so list them on the CLI).
echo "── pytest ──"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
exec python3 -m pytest -c "$SCRIPT_DIR/pytest.ini" -v \
    "$REPO/sdks/python/tests/e2e" \
    "$REPO/sdks/c/tests/e2e" \
    "$REPO/sdks/go/tests/e2e" \
    "$REPO/sdks/node/tests/e2e" \
    "$REPO/src/cli/tests/e2e" \
    "$@"
