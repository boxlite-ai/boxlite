#!/bin/bash
# Build runtime-only native assets before assembling the BoxLite runtime.

set -euo pipefail


SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

PROFILE="${BUILD_PROFILE:-release}"
set_cargo_profile "$PROFILE"

CARGO_TARGET_ROOT=$(cargo_target_dir)
DEST_DIR="$CARGO_TARGET_ROOT/boxlite-runtime/$PROFILE"

print_header "Building runtime assets ($PROFILE)"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

"$SCRIPT_BUILD_DIR/build-e2fsprogs.sh" "$DEST_DIR"
if [ "$(uname -s)" = "Linux" ]; then
    "$SCRIPT_BUILD_DIR/build-bubblewrap.sh" "$DEST_DIR"
fi
"$SCRIPT_BUILD_DIR/build-libkrunfw.sh" "$DEST_DIR"

printf 'Runtime assets built at %s\n' "$DEST_DIR"
