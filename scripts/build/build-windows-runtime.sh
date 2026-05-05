#!/usr/bin/env bash
# Build all BoxLite Windows runtime binaries.
#
# Produces a directory containing:
#   vmlinuz          - Linux kernel (x86_64 bzImage)
#   initrd.img       - Custom initramfs (virtio + vsock + ext4 modules)
#   boxlite-guest    - Guest agent (x86_64-unknown-linux-musl)
#   mke2fs.exe       - ext4 filesystem creation (x86_64-pc-windows-gnu)
#   debugfs.exe      - ext4 file injection (x86_64-pc-windows-gnu)
#
# This script orchestrates the individual build scripts and collects their
# outputs into a single directory suitable for deployment or embedding.
#
# Prerequisites (Ubuntu/Debian):
#   sudo apt-get install gcc-x86-64-linux-gnu gcc-mingw-w64-x86-64 \
#       bc flex bison libelf-dev libssl-dev musl-tools
#   rustup target add x86_64-unknown-linux-musl
#
# Usage:
#   ./scripts/build/build-windows-runtime.sh [output_dir]
#
# Default output: target/windows-runtime/
#
# Environment variables:
#   KERNEL_BUILD_DIR  - Override kernel build directory (default: target/kernel-build)
#   SKIP_KERNEL       - Set to 1 to skip kernel build (reuse existing vmlinuz)
#   SKIP_E2FSPROGS    - Set to 1 to skip e2fsprogs build (reuse existing .exe files)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/target/windows-runtime}"

echo "============================================="
echo "  BoxLite Windows Runtime Builder"
echo "============================================="
echo "Output: $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"

FAILURES=0

# ── Phase 1: Linux kernel (vmlinuz) ──────────────────────────────────────

if [ "${SKIP_KERNEL:-}" = "1" ] && [ -f "$OUTPUT_DIR/vmlinuz" ]; then
    echo "=== Phase 1: Kernel (SKIPPED - SKIP_KERNEL=1) ==="
    echo ""
else
    echo "=== Phase 1: Building Linux kernel ==="
    KERNEL_OUT="$REPO_ROOT/target/kernel-windows-x86_64"
    if "$SCRIPT_DIR/cross-compile-kernel-windows.sh" "$KERNEL_OUT"; then
        cp "$KERNEL_OUT/vmlinuz" "$OUTPUT_DIR/vmlinuz"
        echo "  -> vmlinuz ($(du -h "$OUTPUT_DIR/vmlinuz" | cut -f1))"
    else
        echo "  ERROR: Kernel build failed"
        FAILURES=$((FAILURES + 1))
    fi
    echo ""
fi

# ── Phase 2: Initramfs (initrd.img) ─────────────────────────────────────

echo "=== Phase 2: Building initramfs ==="
# The initrd needs the kernel source for module extraction.
# Use the same kernel source that cross-compile-kernel-windows.sh built.
KERNEL_BUILD="${KERNEL_BUILD_DIR:-$REPO_ROOT/target/kernel-build}"
# Find the kernel source directory (linux-X.Y.Z)
KERNEL_SRC=$(find "$KERNEL_BUILD" -maxdepth 1 -type d -name 'linux-*' 2>/dev/null | head -1)

if [ -z "$KERNEL_SRC" ] || [ ! -d "$KERNEL_SRC" ]; then
    echo "  WARNING: Kernel source not found in $KERNEL_BUILD"
    echo "  Initrd build requires kernel source for module extraction."
    echo "  Run without SKIP_KERNEL=1 first, or provide KERNEL_BUILD_DIR."
    FAILURES=$((FAILURES + 1))
elif "$SCRIPT_DIR/build-initrd-windows.sh" "$KERNEL_SRC" "$OUTPUT_DIR/initrd.img"; then
    echo "  -> initrd.img ($(du -h "$OUTPUT_DIR/initrd.img" | cut -f1))"
else
    echo "  ERROR: Initrd build failed"
    FAILURES=$((FAILURES + 1))
fi
echo ""

# ── Phase 3: boxlite-guest (x86_64-unknown-linux-musl) ──────────────────

echo "=== Phase 3: Building boxlite-guest ==="
GUEST_TARGET="x86_64-unknown-linux-musl"

# Ensure the target is installed
if ! rustup target list --installed | grep -q "$GUEST_TARGET"; then
    echo "  Installing target $GUEST_TARGET..."
    rustup target add "$GUEST_TARGET"
fi

if cargo build -p boxlite --bin boxlite-guest \
    --target "$GUEST_TARGET" \
    --release \
    --manifest-path "$REPO_ROOT/Cargo.toml"; then
    cp "$REPO_ROOT/target/$GUEST_TARGET/release/boxlite-guest" "$OUTPUT_DIR/boxlite-guest"
    echo "  -> boxlite-guest ($(du -h "$OUTPUT_DIR/boxlite-guest" | cut -f1))"
else
    echo "  ERROR: boxlite-guest build failed"
    FAILURES=$((FAILURES + 1))
fi
echo ""

# ── Phase 4: e2fsprogs (mke2fs.exe + debugfs.exe) ───────────────────────

if [ "${SKIP_E2FSPROGS:-}" = "1" ] && [ -f "$OUTPUT_DIR/mke2fs.exe" ] && [ -f "$OUTPUT_DIR/debugfs.exe" ]; then
    echo "=== Phase 4: e2fsprogs (SKIPPED - SKIP_E2FSPROGS=1) ==="
    echo ""
else
    echo "=== Phase 4: Building e2fsprogs ==="
    E2FS_OUT="$REPO_ROOT/target/e2fsprogs-windows-x86_64"
    if "$SCRIPT_DIR/cross-compile-e2fsprogs-windows.sh" "$E2FS_OUT"; then
        cp "$E2FS_OUT/mke2fs.exe" "$OUTPUT_DIR/mke2fs.exe"
        cp "$E2FS_OUT/debugfs.exe" "$OUTPUT_DIR/debugfs.exe"
        echo "  -> mke2fs.exe ($(du -h "$OUTPUT_DIR/mke2fs.exe" | cut -f1))"
        echo "  -> debugfs.exe ($(du -h "$OUTPUT_DIR/debugfs.exe" | cut -f1))"
    else
        echo "  ERROR: e2fsprogs build failed"
        FAILURES=$((FAILURES + 1))
    fi
    echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────

echo "============================================="
echo "  Build Summary"
echo "============================================="
echo ""
echo "Output directory: $OUTPUT_DIR"
echo ""

for f in vmlinuz initrd.img boxlite-guest mke2fs.exe debugfs.exe; do
    if [ -f "$OUTPUT_DIR/$f" ]; then
        size=$(du -h "$OUTPUT_DIR/$f" | cut -f1)
        printf "  %-20s %s\n" "$f" "$size"
    else
        printf "  %-20s MISSING\n" "$f"
    fi
done

echo ""
if [ "$FAILURES" -eq 0 ]; then
    echo "All phases completed successfully."
    echo ""
    echo "To embed in a Windows build, set:"
    echo "  export BOXLITE_KERNEL_DIR=$OUTPUT_DIR"
    echo ""
    echo "Or copy to the default location:"
    echo "  cp -r $OUTPUT_DIR/* target/kernel-windows-x86_64/"
else
    echo "WARNING: $FAILURES phase(s) failed. Check output above."
    exit 1
fi
