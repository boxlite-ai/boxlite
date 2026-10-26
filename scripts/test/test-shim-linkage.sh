#!/usr/bin/env bash
# Build the real Linux shim with `make shim` (vendored libkrun, libkrunfw,
# gvproxy; never BOXLITE_DEPS_STUB) and check that it is one static binary
# whose libkrun checkpoint and gvproxy entry points are defined and that it
# runs. Linkage only: no VM is started. Needs Linux x86_64 and the shim's
# native build tools (Go, patchelf, protoc, pkg-config, static glibc);
# libkrun-sys downloads libkrunfw unless its build cache already has it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
    printf 'test-shim-linkage: %s\n' "$1" >&2
    exit 1
}

[[ "$(uname -s -m)" == "Linux x86_64" ]] || fail "Linux x86_64 is required"
# A stub build skips libkrun and gvproxy and links nothing to check.
[[ -z "${BOXLITE_DEPS_STUB+set}" ]] || fail "unset BOXLITE_DEPS_STUB"

work="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-shim-linkage.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

make -C "$repo_root" shim 2>&1 | tee "$work/build.log"
if grep -q "BOXLITE_DEPS_STUB" "$work/build.log"; then
    fail "the build took a stub path"
fi

shim="$repo_root/target/release/boxlite-shim"
[[ -x "$shim" ]] || fail "no shim at $shim"
file -b "$shim" | grep -q "ELF 64-bit LSB executable, x86-64" ||
    fail "not an x86-64 executable: $(file -b "$shim")"
readelf -d "$shim" 2>&1 | grep -q "There is no dynamic section" ||
    fail "the shim is dynamically linked"

nm "$shim" >"$work/symbols"
# Static glibc leaves its own TLS and locale hooks (`__*`, `_nl_current_LC_*`)
# unresolved; nothing else may be.
if awk '$1 == "U" && $2 !~ /^(__|_nl_current_LC_)/' "$work/symbols" | grep .; then
    fail "undefined symbols above"
fi
# The checkpoint ABI the engine calls, the context lifecycle around it, and
# the network backend.
for symbol in krun_create_ctx krun_start_enter krun_free_ctx \
    krun_snapshot_enable krun_snapshot_import krun_snapshot_pause \
    krun_snapshot_resume krun_snapshot_export krun_snapshot_stop \
    krun_snapshot_get_state krun_snapshot_get_restored_share \
    gvproxy_create gvproxy_destroy; do
    grep -qE "^[0-9a-f]+ T ${symbol}$" "$work/symbols" ||
        fail "$symbol is not defined in the shim"
done

# The binary loads and runs: it reads its config from stdin and refuses an
# empty one.
if "$shim" </dev/null >"$work/run.out" 2>&1; then
    fail "the shim accepted an empty config"
fi
grep -q "Failed to parse config JSON" "$work/run.out" ||
    fail "the shim did not start: $(cat "$work/run.out")"

printf 'test-shim-linkage: %s is static, links libkrun and gvproxy, and runs\n' "$shim"
