#!/usr/bin/env bash
# Entry point: bootstrap (if needed) → fixture_setup → pytest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0. curated image — resolved once from apps/box-images/VERSION and exported so every
# driver (pytest, and the Go/C/Node subprocesses it spawns) agrees on one ref. An
# explicit BOXLITE_E2E_IMAGE still wins.
if [[ -z "${BOXLITE_E2E_IMAGE:-}" ]]; then
    BOXLITE_E2E_IMAGE="$(python3 "$SCRIPT_DIR/lib/images.py")"
fi
if [[ -z "$BOXLITE_E2E_IMAGE" ]]; then
    echo "Unable to resolve BOXLITE_E2E_IMAGE" >&2
    exit 1
fi
export BOXLITE_E2E_IMAGE
echo "── image: $BOXLITE_E2E_IMAGE ──"

# 1. image config — fast unit tests, independent of the VM services.
python3 -m unittest discover -s "$SCRIPT_DIR/lib" -p 'test_*.py'

# 2. bootstrap — idempotent, skips on re-run if services already up
if ! systemctl is-active --quiet boxlite-api; then
    echo "── bootstrap (services not running yet) ──"
    bash "$SCRIPT_DIR/bootstrap.sh"
fi

# 3. fixture data (snapshots / quotas / p1 profile)
echo "── fixture_setup ──"
python3 "$SCRIPT_DIR/fixture_setup.py"

# 4. pip prereqs (pytest, pytest-asyncio, boxlite SDK).
python3 -c "import pytest" 2>/dev/null || \
    pip install --break-system-packages --quiet pytest
python3 -c "import pytest_asyncio" 2>/dev/null || \
    pip install --break-system-packages --quiet pytest-asyncio
python3 -c "import boxlite" 2>/dev/null || \
    pip install --break-system-packages --quiet boxlite

# 5. run
echo "── pytest ──"
cd "$SCRIPT_DIR"
exec python3 -m pytest cases/ -v "$@"
