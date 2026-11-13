#!/usr/bin/env bash
# Run one Linux KVM milestone/engine combination and retain its exact inputs.
# Usage: vmm-matrix.sh m2|m3 suite... (normally called through make).
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
matrix=${1:-}
case "$matrix" in m2|m3) shift ;; *) echo 'matrix must be m2 or m3' >&2; exit 2 ;; esac
engine=${ENGINE:-native}
case "$engine" in native|krun) ;; *) echo 'ENGINE must be native or krun' >&2; exit 2 ;; esac
export BOXLITE_TEST_ENGINE="$engine"
export BOXLITE_TEST_REQUIRE_EGRESS=1
export VMM_KERNEL=${VMM_KERNEL:-"$root/target/vmm/boot/x86_64/vmlinux"}
export BOXLITE_RUNTIME_DIR=${BOXLITE_RUNTIME_DIR:-"$root/target/debug/runtime"}
make_command=${MATRIX_MAKE:-make}
report=${VMM_REPORT_DIR:-"$root/target/vmm-matrix/$matrix-$engine-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
mkdir -p -- "$report"
report=$(cd -- "$report" && pwd)
if [[ -n $(ls -A -- "$report") ]]; then
    echo "report directory must be empty: $report" >&2
    exit 2
fi

stage=inputs
finish() {
    local status=$?
    printf 'stage=%s\nexit_status=%s\n' "$stage" "$status" > "$report/result.txt"
    printf '%s %s results: %s\n' "$matrix" "$engine" "$report"
}
trap finish EXIT

cd -- "$root"
{
    printf 'matrix=%s\nengine=%s\nkernel=%s\nruntime=%s\n' \
        "$matrix" "$engine" "$VMM_KERNEL" "$BOXLITE_RUNTIME_DIR"
    printf 'filter=%s\nfilter_expression=%s\nretries=0\nrequire_egress=1\n' \
        "${FILTER:-}" "${NEXTEST_FILTER_EXPR:-}"
    printf 'suite=%s\n' "$@"
    uname -srmo
    git rev-parse HEAD
    git status --short -- src make scripts .config
} > "$report/inputs.txt"
sha256sum -- "$VMM_KERNEL" > "$report/artifacts.sha256"
find -L "$BOXLITE_RUNTIME_DIR" -type f -print0 | sort -z | \
    xargs -0 -r sha256sum -- >> "$report/artifacts.sha256"
test -f "$BOXLITE_RUNTIME_DIR/boxlite-shim"
test -f "$BOXLITE_RUNTIME_DIR/boxlite-guest"
git diff HEAD --binary > "$report/source.patch"
input_paths=(src/boxlite/tests scripts/test/vmm-matrix.sh make/test.mk .config/nextest.toml)
git ls-files -z --cached --others --exclude-standard -- "${input_paths[@]}" | \
    sort -zu | xargs -0 -r sha256sum -- > "$report/test-inputs.sha256"
git ls-files -z --others --exclude-standard -- "${input_paths[@]}" > "$report/untracked-inputs.list"
tar --null -T "$report/untracked-inputs.list" -cf "$report/untracked-inputs.tar"

stage=list
if "$make_command" --no-print-directory -s "test:integration:vmm:$matrix:list" \
    > "$report/selected-tests.json" 2> "$report/build.log"; then
    stage=run
else
    status=$?
    cat "$report/build.log" >&2
    exit "$status"
fi
"$make_command" --no-print-directory "test:integration:vmm:$matrix:run" 2>&1 | tee "$report/tests.log"
