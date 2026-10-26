#!/bin/sh
# Cargo target runner for libkrun's rootless archive tests: run the test
# binary the way BoxLite's default jailer runs the shim (build_shim_command
# in src/boxlite/src/jailer/bwrap.rs): bwrap with user, PID, IPC and UTS
# namespaces, read-only system binds, a fresh /dev, /proc and /tmp, one
# read-write box directory and a cleared environment. The test binary's
# directory and the seccomp filter are bound read-only, as the shim's
# directory is.
set -eu

bwrap="${BOXLITE_TEST_BWRAP:-bwrap}"
bpf="${KRUN_TEST_SECCOMP_BPF:?KRUN_TEST_SECCOMP_BPF must name the seccomp filter}"
test_bin="$1"
shift
box_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-rootless.XXXXXX")"
trap 'chmod -R u+rwx "$box_dir" 2>/dev/null; rm -rf -- "$box_dir"' EXIT

"$bwrap" \
    --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
    --die-with-parent --new-session \
    --ro-bind-try /usr /usr --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
    --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
    --dev /dev --proc /proc --tmpfs /tmp \
    --bind "$box_dir" "$box_dir" \
    --ro-bind "$(dirname "$test_bin")" "$(dirname "$test_bin")" \
    --ro-bind "$bpf" "$bpf" \
    --clearenv \
    --setenv PATH /usr/bin:/bin:/usr/sbin:/sbin --setenv HOME /root \
    --setenv TMPDIR "$box_dir" --setenv KRUN_TEST_SECCOMP_BPF "$bpf" \
    --chdir / \
    -- "$test_bin" "$@"
