#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
wrapper="$root/scripts/test/run-c-test.sh"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-c-wrapper-test.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
fail() { echo "C test wrapper: $*" >&2; exit 1; }
export BOXLITE_HOME="$scratch/outer"
mkdir "$BOXLITE_HOME" "$scratch/temp with spaces"
printf 'untouched\n' > "$BOXLITE_HOME/sentinel"
export TMPDIR="$scratch/temp with spaces"

# Exit status, argument boundaries, overriding the caller, and cleanup.
for expected in 0 37; do
    status=0
    bash "$wrapper" bash -c '
        [[ "$1" == "argument with spaces" ]] || exit 90
        [[ -d "$BOXLITE_HOME" && "$BOXLITE_HOME" != "$2" ]] || exit 91
        printf "%s\n" "$BOXLITE_HOME" > "$3"
        exit "$4"
    ' _ 'argument with spaces' "$BOXLITE_HOME" "$scratch/home" "$expected" || status=$?
    [[ "$status" == "$expected" ]] || fail "expected exit $expected, got $status"
    [[ ! -e "$(cat "$scratch/home")" ]] || fail 'home survived exit'
done

if TMPDIR="$scratch/missing/parent" bash "$wrapper" touch "$scratch/ran"; then
    fail 'directory creation failure was accepted'
fi
[[ ! -e "$scratch/ran" ]] || fail 'child ran without a temporary directory'

# FIFOs synchronize two live children without polling or sleeps.
mkfifo "$scratch/ready" "$scratch/release"
exec 3<>"$scratch/ready" 4<>"$scratch/release"
for index in 1 2; do
    bash "$wrapper" bash -c '
        printf "%s\n" "$BOXLITE_HOME" >&3
        read -r release <&4
    ' &
    if [[ "$index" == 1 ]]; then first=$!; else second=$!; fi
done
read -r first_home <&3
read -r second_home <&3
[[ "$first_home" != "$second_home" ]] || fail 'concurrent homes collided'
[[ -d "$first_home" && -d "$second_home" ]] || fail 'live home missing'
printf 'go\ngo\n' >&4
wait "$first"
wait "$second"
[[ ! -e "$first_home" && ! -e "$second_home" ]] || fail 'concurrent homes survived'

# Signal only the wrapper; it must reap its child before removing the home.
for signal in HUP TERM; do
    bash "$wrapper" bash -c '
        printf "%s\n" "$BOXLITE_HOME" >&3
        read -r release <&4
    ' &
    runner=$!
    read -r child_home <&3
    kill -s "$signal" "$runner"
    status=0
    wait "$runner" || status=$?
    case "$signal:$status" in HUP:129|TERM:143) ;; *) fail "$signal returned $status" ;; esac
    [[ ! -e "$child_home" ]] || fail "$signal left home behind"
done

# A foreground launch retains SIGINT (background shells may ignore it).
status=0
bash "$wrapper" bash -c '
    printf "%s\n" "$BOXLITE_HOME" > "$1"
    kill -INT "$PPID"
    read -r release <&4
' _ "$scratch/home" || status=$?
[[ "$status" == 130 ]] || fail "INT returned $status"
[[ ! -e "$(cat "$scratch/home")" ]] || fail 'INT left home behind'
[[ "$(cat "$BOXLITE_HOME/sentinel")" == untouched ]] || fail 'outer home changed'
echo 'C test wrapper checks passed'
