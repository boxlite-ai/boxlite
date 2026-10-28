#!/usr/bin/env bash
# Run libkrun's filesystem checkpoint tests, including received v9 orphan/DAX
# roles, without privilege under real
# bwrap (snapshot-rootless-runner.sh) and BoxLite's production VMM seccomp
# filter. Needs Linux x86_64, an unprivileged user that may create user
# namespaces, bwrap (BOXLITE_TEST_BWRAP or PATH) and the cargo registry
# offline. Never falls back to another sandbox.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
libkrun="$repo_root/src/deps/libkrun-sys/vendor/libkrun"
target="x86_64-unknown-linux-gnu"

fail() {
    printf 'test-snapshot-rootless: %s\n' "$1" >&2
    exit 1
}

[[ "$(uname -s -m)" == "Linux x86_64" ]] || fail "Linux x86_64 is required"
[[ "$(id -u)" != 0 ]] || fail "run as an unprivileged user: root is not rootless evidence"
bwrap="${BOXLITE_TEST_BWRAP:-bwrap}"
command -v "$bwrap" >/dev/null || fail "bwrap not found (set BOXLITE_TEST_BWRAP)"
"$bwrap" --unshare-user --ro-bind / / true ||
    fail "bwrap cannot create a user namespace here"

work="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-rootless-test.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
# The x86_64 filters' decisions on the snapshot syscalls, then the filter
# the tests install.
cargo test --quiet --offline \
    --manifest-path "$repo_root/scripts/test/seccomp-bpf/Cargo.toml" \
    --target-dir "$work/seccomp-bpf"
cargo run --quiet --offline \
    --manifest-path "$repo_root/scripts/test/seccomp-bpf/Cargo.toml" \
    --target-dir "$work/seccomp-bpf" -- \
    "$repo_root/src/boxlite/resources/seccomp/$target.json" x86_64 vmm "$work/vmm.bpf"

BOXLITE_TEST_BWRAP="$(command -v "$bwrap")" make -C "$libkrun" snapshot-rootless-test \
    SNAPSHOT_TARGET="$target" \
    SNAPSHOT_RUNNER="$repo_root/scripts/test/snapshot-rootless-runner.sh" \
    SNAPSHOT_SECCOMP_BPF="$work/vmm.bpf" \
    ${SNAPSHOT_CARGO_FLAGS:+SNAPSHOT_CARGO_FLAGS="$SNAPSHOT_CARGO_FLAGS"}

# The host runtime's real disk copier must handle ENOSPC before publication,
# keeping its owner Paused. The same runner supplies a one-MiB tmpfs; this
# does not require a VM and does not change the host mount namespace.
runner_var="CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER"
env "$runner_var=$repo_root/scripts/test/snapshot-rootless-runner.sh" \
    BOXLITE_TEST_BWRAP="$(command -v "$bwrap")" KRUN_TEST_SECCOMP_BPF="$work/vmm.bpf" \
    cargo test --offline --manifest-path "$repo_root/Cargo.toml" -p boxlite --no-default-features \
    --lib --target "$target" checkpoint_export_disk_full_preserves_paused_source_and_cleans_staging \
    -- --ignored --test-threads=1 --nocapture
