#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact_dir="$repo_root/target/node-native"
mkdir -p "$artifact_dir"
export BOXLITE_DEPS_STUB=1
export CARGO_TARGET_DIR="$artifact_dir/cargo"
export BOXLITE_NODE_NATIVE_LOADER="$artifact_dir/boxlite.mjs"
# Do not allow a caller's binding override to bypass the source build.
unset NAPI_RS_NATIVE_LIBRARY_PATH
cd "$repo_root/sdks/node"
npm exec -- napi build --platform --js boxlite.mjs --esm --output-dir "$artifact_dir" --target-dir "$CARGO_TARGET_DIR"
npm exec -- vitest run --project native "$@"
