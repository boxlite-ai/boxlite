#!/usr/bin/env bash
# Build the test-only static launcher used by native guest boot qualification.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
# shellcheck source=scripts/build/build-libseccomp.sh
source "$root/scripts/build/build-libseccomp.sh"
ensure_libseccomp_for_target x86_64-unknown-linux-musl
cd "$root"
cargo build --target x86_64-unknown-linux-musl -p boxlite-guest --example guest-boot-probe
