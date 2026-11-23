#!/bin/bash
# Build the release CLI and package the runtime reported by Cargo.
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
    printf 'Usage: %s <release-target>\n' "$0" >&2
    exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "$script_dir/../.." && pwd)
cd "$project_root"

version=$(awk -F '"' '/^version = "/ { print $2; exit }' Cargo.toml)
if [[ ! "$version" =~ ^[0-9][a-zA-Z0-9.+-]*$ ]]; then
    printf 'Cannot determine the runtime release version from Cargo.toml\n' >&2
    exit 1
fi
archive="$project_root/boxlite-runtime-v${version}-$1.tar.gz"
rm -f "$archive"

staging=$(mktemp -d "$project_root/.boxlite-runtime.XXXXXX")
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

# Give the archive its release layout without copying the unpacked runtime.
ln -s "$runtime_dir" "$staging/boxlite-runtime"
tar -chzf "$staging/runtime.tar.gz" -C "$staging" boxlite-runtime/
chmod 0644 "$staging/runtime.tar.gz"
mv "$staging/runtime.tar.gz" "$archive"
