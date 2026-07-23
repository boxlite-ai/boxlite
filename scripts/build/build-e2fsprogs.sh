#!/bin/bash
# Build the e2fsprogs tools shipped in the BoxLite runtime.

set -euo pipefail

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

DEST_DIR=${1:?usage: build-e2fsprogs.sh DEST_DIR}
SOURCE_DIR="$PROJECT_ROOT/vendor/e2fsprogs"
CARGO_TARGET_ROOT=$(cargo_target_dir)
BUILD_DIR="$CARGO_TARGET_ROOT/native-build/e2fsprogs"

if [ ! -x "$SOURCE_DIR/configure" ]; then
    echo "e2fsprogs source is missing; initialize vendor submodules" >&2
    exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DEST_DIR"
(
    cd "$BUILD_DIR"
    "$SOURCE_DIR/configure" \
        --disable-nls \
        --disable-tdb \
        --disable-imager \
        --disable-resizer \
        --disable-defrag \
        --disable-fsck \
        --disable-e2initrd-helper \
        --enable-libuuid \
        --enable-libblkid
)

make -j -C "$BUILD_DIR" libs
make -j -C "$BUILD_DIR/misc" mke2fs
make -j -C "$BUILD_DIR/debugfs" debugfs
install -m 755 "$BUILD_DIR/misc/mke2fs" "$DEST_DIR/mke2fs"
install -m 755 "$BUILD_DIR/debugfs/debugfs" "$DEST_DIR/debugfs"
