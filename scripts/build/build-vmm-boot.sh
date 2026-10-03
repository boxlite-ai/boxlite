#!/usr/bin/env bash
# Export first-boot artifacts without installing a host kernel toolchain.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
output="$root/target/vmm/boot/x86_64"
build_args=(--target artifacts)
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output)
            [ "$#" -ge 2 ] && [ -n "$2" ] || { echo 'ERROR: --output requires a directory' >&2; exit 2; }
            output="$2"; shift 2 ;;
        --rebuild) build_args+=(--no-cache-filter build); shift ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done
# Buildx parses --output as CSV, so these characters cannot be literal paths.
case "$output" in
    *','*|*$'\n'*|*$'\r'*|*'"'*) echo 'ERROR: output directory contains a Buildx CSV delimiter' >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo 'ERROR: Docker with Buildx is required' >&2; exit 1; }
docker buildx build "${build_args[@]}" \
    --output "type=local,dest=$output" "$root/src/vmm/boot"
printf 'Boot artifacts: %s\n' "$output"
