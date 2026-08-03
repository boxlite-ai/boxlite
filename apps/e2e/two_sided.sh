#!/usr/bin/env bash
# Two-sided e2e: prove the test suite (a) deterministically catches the bug
# AND (b) the candidate fix removes it.
#
# Phase A: build runner from MAIN_REF (no fix)  →  expect pytest exit 1
# Phase B: build runner from PR_REF (with fix)  →  expect pytest exit 0
#
# Exits 0 only when (A=1 AND B=0). Restores the original runner binary
# on any exit path.

set -euo pipefail

REPO="${REPO:-$HOME/ws/boxlite}"
MAIN_REF="${MAIN_REF:-main}"
PR_REF="${PR_REF:?must set PR_REF=<branch-with-fix>}"
RUNNER_BIN=/usr/local/bin/boxlite-runner
ORIG_BACKUP=/usr/local/bin/boxlite-runner.preE2E.bak
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo cp "$RUNNER_BIN" "$ORIG_BACKUP"
trap 'echo "(restoring runner binary)"; sudo cp "$ORIG_BACKUP" "$RUNNER_BIN" && sudo systemctl restart boxlite-runner; exit ${1:-0}' EXIT

build_runner() {
    local ref="$1" out="$2"
    echo "── build runner @ $ref → $out ──"
    cd "$REPO"
    git checkout "$ref" >/dev/null 2>&1
    cargo build --release -p boxlite-c >/dev/null 2>&1
    cp target/release/libboxlite.a sdks/go/libboxlite.a
    cd "$REPO/apps/runner"
    CGO_ENABLED=1 go build -o "$out" ./cmd/runner
}

swap_and_restart() {
    sudo systemctl stop boxlite-runner
    sudo cp "$1" "$RUNNER_BIN"
    sudo chmod +x "$RUNNER_BIN"
    sudo systemctl start boxlite-runner
    for _ in $(seq 1 30); do
        ss -ltn 2>/dev/null | grep -q ":8080" && return
        sleep 1
    done
    echo "runner failed on :8080" >&2
    exit 2
}

build_runner "$MAIN_REF" /tmp/boxlite-runner-main
swap_and_restart         /tmp/boxlite-runner-main
sleep 2
echo ""
echo "═══ Phase A: against MAIN runner — expect FAIL ═══"
set +e
python3 -m pytest "$SCRIPT_DIR/cases/" -v
PHASE_A=$?
set -e
echo "Phase A exit = $PHASE_A (expect 1)"

build_runner "$PR_REF" /tmp/boxlite-runner-pr
swap_and_restart       /tmp/boxlite-runner-pr
sleep 2
echo ""
echo "═══ Phase B: against PR runner — expect PASS ═══"
set +e
python3 -m pytest "$SCRIPT_DIR/cases/" -v
PHASE_B=$?
set -e
echo "Phase B exit = $PHASE_B (expect 0)"

echo ""
echo "═══ Two-sided verdict ═══"
if [[ $PHASE_A -eq 1 && $PHASE_B -eq 0 ]]; then
    echo "PASS — test catches bug + PR removes it"
    exit 0
elif [[ $PHASE_A -eq 0 && $PHASE_B -eq 0 ]]; then
    echo "INDETERMINATE — both passed; raise BOXLITE_E2E_P06_ROUNDS"
    exit 2
elif [[ $PHASE_A -eq 1 && $PHASE_B -eq 1 ]]; then
    echo "FAIL — PR did NOT clear the regression"
    exit 1
else
    echo "FAIL — unexpected combination (A=$PHASE_A B=$PHASE_B)"
    exit 1
fi
