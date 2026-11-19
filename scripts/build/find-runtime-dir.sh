#!/bin/bash
# Print the newest BoxLite runtime directory across supported Cargo layouts.
set -eu

if [[ $# -ne 1 ]]; then
    printf 'Usage: %s BUILD_DIR\n' "$0" >&2
    exit 2
fi

build_dir=$1
runtime_dir=""
for candidate in "$build_dir"/boxlite-*/out/runtime "$build_dir"/boxlite/*/out/runtime; do
    [[ -d "$candidate" ]] || continue
    if [[ -z "$runtime_dir" || "$candidate" -nt "$runtime_dir" ]]; then
        runtime_dir=$candidate
    fi
done

if [[ -z "$runtime_dir" ]]; then
    printf 'ERROR: Runtime directory not found under %s\n' "$build_dir" >&2
    exit 1
fi

printf '%s\n' "$runtime_dir"
