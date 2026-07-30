#!/usr/bin/env bash
# Verify the packaged Linux shim can load the packaged libkrunfw on the
# deployment glibc before KVM is required.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <runtime-directory>" >&2
  exit 2
fi

runtime_dir=$(cd "$1" && pwd)
shim="$runtime_dir/boxlite-shim"
firmware="$runtime_dir/libkrunfw.so.5"

for command in jq readelf timeout; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required for the shim loader smoke" >&2
    exit 1
  }
done
[[ -x "$shim" ]] || {
  echo "error: executable shim is missing at $shim" >&2
  exit 1
}
[[ -f "$firmware" && ! -L "$firmware" ]] || {
  echo "error: regular libkrunfw ABI file is missing at $firmware" >&2
  exit 1
}

machine=$(readelf -h "$firmware" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')
needed=$(readelf -d "$firmware" | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p')
readelf -d "$firmware" | grep -q 'SONAME.*\[libkrunfw.so.5\]' || {
  echo "error: libkrunfw does not declare SONAME libkrunfw.so.5" >&2
  exit 1
}
case "$machine" in
  *X86-64*)
    if grep -Fxq 'libc.so.6' <<<"$needed"; then
      echo "error: x86_64 libkrunfw must not load a second, host-version libc from the static shim" >&2
      exit 1
    fi
    ;;
  *AArch64*)
    grep -Fxq 'libc.so.6' <<<"$needed" || {
      echo "error: aarch64 libkrunfw requires libc.so.6 for static-shim dlopen" >&2
      exit 1
    }
    ;;
  *)
    echo "error: unsupported libkrunfw machine: $machine" >&2
    exit 1
    ;;
esac

probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-shim-loader.XXXXXX")
cleanup() {
  rm -rf "$probe_dir"
}
trap cleanup EXIT
mkdir -p "$probe_dir/rootfs"

jq -n --arg root "$probe_dir" '{
  engine: "Libkrun",
  box_id: "dlopen-test",
  security: {jailer_enabled: false},
  cpus: 1,
  memory_mib: 128,
  fs_shares: {shares: []},
  block_devices: {devices: []},
  guest_entrypoint: {executable: "/bin/true", args: [], env: []},
  transport: {Unix: {socket_path: ($root + "/agent.sock")}},
  ready_transport: {Unix: {socket_path: ($root + "/ready.sock")}},
  guest_rootfs: {
    path: ($root + "/rootfs"),
    strategy: "Direct",
    kernel: null,
    initrd: null,
    env: []
  },
  network_backend_spec: null,
  disable_network: true,
  home_dir: $root,
  console_output: null,
  exit_file: ($root + "/exit"),
  detach: true
}' >"$probe_dir/config.json"

set +e
LD_LIBRARY_PATH="$runtime_dir" timeout 15 "$shim" \
  <"$probe_dir/config.json" >"$probe_dir/stdout" 2>"$probe_dir/stderr"
probe_status=$?
set -e

if grep -q 'Couldn.t find or load libkrunfw.so.5' "$probe_dir/stderr"; then
  cat "$probe_dir/stderr" >&2
  echo "error: packaged shim could not load packaged libkrunfw" >&2
  exit 1
fi
if ! grep -q 'instance created (krun FFI calls done)' "$probe_dir/stderr"; then
  cat "$probe_dir/stderr" >&2
  echo "error: packaged shim failed before completing libkrun FFI initialization (status=$probe_status)" >&2
  exit 1
fi

echo "shim loader smoke passed before KVM entry: machine=$machine"
