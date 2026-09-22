#!/usr/bin/env bash
# Keep C SDK tests away from the caller's runtime and database.
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
    echo "Usage: $0 TEST [ARG ...]" >&2
    exit 2
fi

test_home=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-c-test.XXXXXX")
child_pid=
cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if ! rm -rf -- "$test_home"; then
        echo "Failed to remove C test directory: $test_home" >&2
        if [[ "$status" -eq 0 ]]; then status=1; fi
    fi
    exit "$status"
}
interrupt() {
    if [[ -n "$child_pid" ]]; then
        kill -TERM -- "-$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
    fi
    exit "$1"
}
trap cleanup EXIT
trap 'interrupt 129' HUP
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

# Give the test its own process group and preserve catchable SIGINT for children.
set -m
BOXLITE_HOME="$test_home" "$@" <&0 &
child_pid=$!
status=0
wait "$child_pid" || status=$?
exit "$status"
