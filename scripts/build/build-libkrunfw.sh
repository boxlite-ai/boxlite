#!/bin/bash
# Build the libkrunfw runtime sidecar outside Cargo's build graph.

set -euo pipefail

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

DEST_DIR=${1:?usage: build-libkrunfw.sh DEST_DIR}
CARGO_TARGET_ROOT=$(cargo_target_dir)
BUILD_ROOT="$CARGO_TARGET_ROOT/native-build/libkrunfw"

mkdir -p "$BUILD_ROOT" "$DEST_DIR"

if [ "$(uname -s)" = "Darwin" ]; then
    VERSION=v5.3.0
    URL="https://github.com/boxlite-ai/libkrunfw/releases/download/$VERSION/libkrunfw-prebuilt-aarch64.tgz"
    SHA256=12b9401d7735d1682450e4d025273c5016ec2237dcbfb76b2f0a152be6e606d6
    TARBALL="$BUILD_ROOT/libkrunfw-prebuilt-$VERSION.tgz"
    PREBUILT_DIR="$BUILD_ROOT/prebuilt-$VERSION"
    if [ ! -f "$PREBUILT_DIR/libkrunfw/kernel.c" ]; then
        curl -fsSL "$URL" -o "$TARBALL"
        printf '%s  %s\n' "$SHA256" "$TARBALL" | shasum -a 256 -c -
        rm -rf "$PREBUILT_DIR"
        mkdir -p "$PREBUILT_DIR"
        tar xzf "$TARBALL" -C "$PREBUILT_DIR"
    fi
    make -j -C "$PREBUILT_DIR/libkrunfw"
    install -m 755 \
        "$PREBUILT_DIR/libkrunfw/libkrunfw.5.dylib" \
        "$DEST_DIR/libkrunfw.5.dylib"
    exit 0
fi

VENDOR_DIR="$PROJECT_ROOT/vendor/libkrunfw"
SOURCE_DIR="$BUILD_ROOT/source"
SOURCE_STAMP="$SOURCE_DIR/.boxlite-source-commit"
if [ ! -f "$VENDOR_DIR/Makefile" ]; then
    echo "libkrunfw source is missing; initialize vendor submodules" >&2
    exit 1
fi
source_commit=$(git -C "$VENDOR_DIR" rev-parse HEAD)
if [ ! -f "$SOURCE_STAMP" ] || [ "$(cat "$SOURCE_STAMP")" != "$source_commit" ]; then
    rm -rf "$SOURCE_DIR"
    mkdir -p "$SOURCE_DIR"
    # Build from a copy so generated kernels never dirty the submodule.
    git -C "$VENDOR_DIR" archive HEAD | tar xf - -C "$SOURCE_DIR"
    printf '%s\n' "$source_commit" > "$SOURCE_STAMP"
fi

make_args=()
if ! command -v gcc >/dev/null 2>&1; then
    command -v clang >/dev/null 2>&1 || { echo "building libkrunfw requires gcc or clang" >&2; exit 1; }
    make_args+=(LLVM=1)
fi

kernel_path() {
    local version
    version=$(sed -n 's/^KERNEL_VERSION[[:space:]]*=[[:space:]]*//p' "$SOURCE_DIR/Makefile" | head -1)
    case "$(uname -m)" in
        x86_64|amd64) printf '%s/%s/vmlinux\n' "$SOURCE_DIR" "$version" ;;
        aarch64|arm64) printf '%s/%s/arch/arm64/boot/Image\n' "$SOURCE_DIR" "$version" ;;
        *) echo "unsupported libkrunfw architecture: $(uname -m)" >&2; return 1 ;;
    esac
}

for command in bc bison flex make patch perl python3; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "building the libkrunfw kernel requires $command; run 'make setup:build'" >&2
        exit 1
    fi
done

host=$(rustc_host_triple)
if [[ "$host" == *-musl ]]; then
    kernel=$(kernel_path)
    relative=${kernel#"$SOURCE_DIR/"}
    make -j -C "$SOURCE_DIR" MAKEFLAGS= "${make_args[@]}" "$relative"
    install -m 755 "$kernel" "$DEST_DIR/libkrunfw.bin"
    exit 0
fi

if ! python3 -c 'import elftools.elf.elffile' >/dev/null 2>&1; then
    echo "building libkrunfw requires Python pyelftools" >&2
    exit 1
fi

make -j -C "$SOURCE_DIR" MAKEFLAGS= "${make_args[@]}"
install -m 755 "$SOURCE_DIR/libkrunfw.so.5.3.0" "$DEST_DIR/libkrunfw.so.5"
