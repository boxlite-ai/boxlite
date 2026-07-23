#!/bin/bash
# Build the bubblewrap executable shipped in Linux runtimes.

set -euo pipefail

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

DEST_DIR=${1:?usage: build-bubblewrap.sh DEST_DIR}
SOURCE_DIR="$PROJECT_ROOT/vendor/bubblewrap"
CARGO_TARGET_ROOT=$(cargo_target_dir)
BUILD_DIR="$CARGO_TARGET_ROOT/native-build/bubblewrap"

if [ ! -f "$SOURCE_DIR/meson.build" ]; then
    echo "bubblewrap source is missing; initialize vendor submodules" >&2
    exit 1
fi

rm -rf "$BUILD_DIR"
meson setup "$BUILD_DIR" "$SOURCE_DIR" \
    -Dselinux=disabled \
    -Dman=disabled \
    -Dtests=false \
    -Dbash_completion=disabled \
    -Dzsh_completion=disabled

meson compile -C "$BUILD_DIR" bwrap
mkdir -p "$DEST_DIR"
install -m 755 "$BUILD_DIR/bwrap" "$DEST_DIR/bwrap"
