#!/usr/bin/env bash
# Cross-compile Linux kernel (bzImage) for BoxLite Windows WHPX boot.
#
# Produces an x86_64 bzImage with all virtio drivers and ext4 built-in,
# so no initrd is needed. Uses the same kernel config as libkrunfw.
#
# Requires: x86_64-linux-gnu-gcc (cross-compiler) on aarch64 host
#   Ubuntu/Debian: sudo apt-get install gcc-x86-64-linux-gnu
# Also needs:     bc flex bison libelf-dev libssl-dev
#
# Can also be run natively on x86_64 Linux (no cross-compiler needed).
#
# Usage:
#   ./scripts/build/cross-compile-kernel-windows.sh [output_dir]
#
# Output:
#   <output_dir>/vmlinuz     (bzImage, ~11-13 MB)
#
# The kernel is built from the same source and config as libkrunfw,
# ensuring identical driver support (VIRTIO_BLK=y, VIRTIO_NET=y,
# VIRTIO_MMIO=y, EXT4_FS=y — all built-in, no modules needed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KRUNFW_DIR="$REPO_ROOT/src/deps/libkrun-sys/vendor/libkrunfw"
OUTPUT_DIR="${1:-$REPO_ROOT/target/kernel-windows-x86_64}"

# BUILD_DIR can be overridden (e.g., when repo is on a read-only mount like Lima)
BUILD_DIR="${KERNEL_BUILD_DIR:-$REPO_ROOT/target/kernel-build}"

# Detect host architecture
HOSTARCH=$(uname -m)

# Determine if cross-compilation is needed
if [ "$HOSTARCH" = "x86_64" ]; then
    echo "=== Native x86_64 build ==="
    CROSS_COMPILE=""
    COMPILER="gcc"
else
    echo "=== Cross-compiling for x86_64 from $HOSTARCH ==="
    CROSS_COMPILE="x86_64-linux-gnu-"
    COMPILER="${CROSS_COMPILE}gcc"

    if ! command -v "$COMPILER" &>/dev/null; then
        echo "ERROR: $COMPILER not found."
        echo "Install: sudo apt-get install gcc-x86-64-linux-gnu"
        exit 1
    fi
fi

# Verify prerequisites
for tool in make bc flex bison; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found."
        echo "Install: sudo apt-get install make bc flex bison libelf-dev libssl-dev"
        exit 1
    fi
done

# Read kernel version from libkrunfw Makefile
KERNEL_VERSION=$(grep '^KERNEL_VERSION' "$KRUNFW_DIR/Makefile" | head -1 | awk '{print $3}')
if [ -z "$KERNEL_VERSION" ]; then
    echo "ERROR: Could not determine kernel version from $KRUNFW_DIR/Makefile"
    exit 1
fi

KERNEL_REMOTE="https://cdn.kernel.org/pub/linux/kernel/v6.x/${KERNEL_VERSION}.tar.xz"
KERNEL_CONFIG="$KRUNFW_DIR/config-libkrunfw_x86_64"

if [ ! -f "$KERNEL_CONFIG" ]; then
    echo "ERROR: Kernel config not found at $KERNEL_CONFIG"
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

# Build in a persistent directory (kernel builds are large)
mkdir -p "$BUILD_DIR"

echo "=== Building Linux kernel bzImage for WHPX ==="
echo "Version: $KERNEL_VERSION"
echo "Config:  $KERNEL_CONFIG"
echo "Build:   $BUILD_DIR"
echo "Output:  $OUTPUT_DIR"
echo "Cross:   ${CROSS_COMPILE:-native} ($($COMPILER --version | head -1))"
echo ""

# Download kernel sources if not present
TARBALL="$BUILD_DIR/${KERNEL_VERSION}.tar.xz"
if [ ! -f "$TARBALL" ]; then
    echo "--- Downloading kernel sources ---"
    curl -L "$KERNEL_REMOTE" -o "$TARBALL"
fi

# Extract if not already done
KERNEL_SRC="$BUILD_DIR/$KERNEL_VERSION"
if [ ! -d "$KERNEL_SRC" ]; then
    echo "--- Extracting kernel sources ---"
    tar xf "$TARBALL" -C "$BUILD_DIR"

    # Apply libkrunfw patches
    echo "--- Applying libkrunfw patches ---"
    for patch in $(find "$KRUNFW_DIR/patches/" -name "0*.patch" 2>/dev/null | sort); do
        echo "  Applying: $(basename "$patch")"
        patch -p1 -d "$KERNEL_SRC" < "$patch"
    done
fi

# Copy config
echo "--- Configuring kernel ---"
cp "$KERNEL_CONFIG" "$KERNEL_SRC/.config"

# Update config for current toolchain (resolves version-specific options)
make -C "$KERNEL_SRC" ARCH=x86 CROSS_COMPILE="$CROSS_COMPILE" olddefconfig

# Build bzImage
JOBS=$(nproc 2>/dev/null || echo 4)
echo ""
echo "--- Building bzImage (j$JOBS) ---"
make -C "$KERNEL_SRC" \
    ARCH=x86 \
    CROSS_COMPILE="$CROSS_COMPILE" \
    KBUILD_BUILD_TIMESTAMP="Mon Dec 15 19:43:20 CET 2025" \
    KBUILD_BUILD_USER=root \
    KBUILD_BUILD_HOST=libkrunfw \
    -j"$JOBS" \
    bzImage

BZIMAGE="$KERNEL_SRC/arch/x86/boot/bzImage"
if [ ! -f "$BZIMAGE" ]; then
    echo "ERROR: bzImage not found at $BZIMAGE"
    exit 1
fi

# Copy output
mkdir -p "$OUTPUT_DIR"
cp "$BZIMAGE" "$OUTPUT_DIR/vmlinuz"
SIZE=$(du -h "$OUTPUT_DIR/vmlinuz" | cut -f1)

echo ""
echo "=== Done ==="
echo "Kernel:  $OUTPUT_DIR/vmlinuz ($SIZE)"
echo "Format:  bzImage (Linux x86_64)"
echo "Config:  libkrunfw (VIRTIO_BLK=y, VIRTIO_NET=y, EXT4_FS=y — all built-in)"
echo "Initrd:  NOT REQUIRED (all drivers built-in)"
