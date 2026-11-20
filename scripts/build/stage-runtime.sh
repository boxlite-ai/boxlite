#!/bin/bash
# Build the release CLI and materialize its runtime for host-side packaging.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "$script_dir/../.." && pwd)
cd "$project_root"

# A failed build must not leave an earlier runtime available for packaging.
mkdir -p dist
rm -rf dist/runtime
staging=$(mktemp -d "$project_root/dist/.runtime.XXXXXX")
trap 'rm -rf "$staging"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

runtime_dir=$(bash "$script_dir/cargo-runtime-dir.sh" -p boxlite-cli --release)
for binary in boxlite-shim boxlite-guest guest-mke2fs guest-resize2fs; do
    if [[ ! -f "$runtime_dir/$binary" || ! -s "$runtime_dir/$binary" || ! -x "$runtime_dir/$binary" ]]; then
        printf 'Missing or invalid runtime executable: %s\n' "$runtime_dir/$binary" >&2
        exit 1
    fi
done

mkdir "$staging/boxlite-runtime"
# Dereference links while still in the build environment (not on the host).
cp -aL "$runtime_dir/." "$staging/boxlite-runtime/"
mv "$staging" dist/runtime
