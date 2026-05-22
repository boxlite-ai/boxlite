#!/usr/bin/env bash
# Build the "fat" libkrunfw variant required by `boxlite run --privileged`.
#
# Steps:
#   1. Resolve target arch (overlay + libkrunfw config are arch-specific)
#   2. Ensure the libkrunfw submodule is checked out
#   3. Build the lean config + the privileged overlay → patched .config
#   4. Run `make` inside vendor/libkrunfw to produce a kernel .so
#   5. Rename SONAME to libkrunfw-privileged.so.5 and copy to
#      target/privileged-kernel/lib64/ — libkrun-sys/build.rs auto-detects this
#      canonical path on the next `make runtime:debug` / `cargo build`. Set
#      BOXLITE_LIBKRUNFW_PRIVILEGED_PATH only when the blob lives outside the
#      workspace (e.g., CI cache, distro packaging).
#
# Why not download a prebuilt: the privileged kernel adds ~2 MB of network
# subsystems on top of the lean kernel. Until upstream boxlite-ai/libkrunfw
# starts publishing the privileged variant in its releases, anyone iterating on
# `--privileged` needs to build it locally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LIBKRUNFW_SRC="$REPO_ROOT/src/deps/libkrun-sys/vendor/libkrunfw"
OVERLAY_DIR="$REPO_ROOT/src/deps/libkrun-sys/privileged-configs"
OUT_DIR="$REPO_ROOT/target/privileged-kernel/lib64"

ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64)  KCONFIG_NAME="config-libkrunfw_x86_64";  OVERLAY_NAME="overlay-privileged_x86_64"  ;;
  aarch64|arm64) KCONFIG_NAME="config-libkrunfw_aarch64"; OVERLAY_NAME="overlay-privileged_aarch64" ;;
  *) echo "❌ unsupported ARCH=$ARCH (only x86_64 and aarch64 have a privileged overlay yet)" >&2; exit 1 ;;
esac

# ── Sanity ──────────────────────────────────────────────────────────────────

if [ ! -f "$LIBKRUNFW_SRC/Makefile" ]; then
  echo "❌ libkrunfw submodule not initialised at $LIBKRUNFW_SRC" >&2
  echo "   Run:  git submodule update --init --recursive src/deps/libkrun-sys/vendor/libkrunfw" >&2
  exit 1
fi

LEAN_CONFIG="$LIBKRUNFW_SRC/$KCONFIG_NAME"
OVERLAY="$OVERLAY_DIR/$OVERLAY_NAME"
if [ ! -f "$LEAN_CONFIG" ]; then
  echo "❌ lean config not found: $LEAN_CONFIG" >&2; exit 1
fi
if [ ! -f "$OVERLAY" ]; then
  echo "❌ privileged overlay not found: $OVERLAY" >&2; exit 1
fi

# ── Build a merged config in a tempfile ─────────────────────────────────────
#
# Append the overlay to the lean config. The overlay's `CONFIG_X=y` lines
# OVERRIDE the lean config's `# CONFIG_X is not set` lines because Kconfig
# parses sequentially. `make olddefconfig` (run by libkrunfw's own Makefile)
# fills in any dependent options that newly-enabled parents require.
MERGED_CONFIG="$(mktemp)"
trap 'rm -f "$MERGED_CONFIG"' EXIT
cat "$LEAN_CONFIG" "$OVERLAY" > "$MERGED_CONFIG"

# Replace the lean config in place so libkrunfw's Makefile (which always
# reads $KCONFIG_NAME) picks up the merged one. Restore on exit so the
# normal lean build path isn't permanently changed.
LEAN_BACKUP="$(mktemp)"
trap 'rm -f "$MERGED_CONFIG" "$LEAN_BACKUP"; cp -f "$LEAN_BACKUP" "$LEAN_CONFIG" 2>/dev/null || true' EXIT
cp "$LEAN_CONFIG" "$LEAN_BACKUP"
cp "$MERGED_CONFIG" "$LEAN_CONFIG"

# ── Build ───────────────────────────────────────────────────────────────────

echo "🔨 Building libkrunfw with privileged overlay ($ARCH)..."
echo "   lean cfg:    $LEAN_CONFIG"
echo "   overlay:     $OVERLAY"
echo "   merged size: $(wc -l < "$MERGED_CONFIG") lines"

cd "$LIBKRUNFW_SRC"
# `make` here triggers the full upstream libkrunfw build:
#   - downloads kernel.org tarball if missing
#   - applies libkrunfw patches
#   - copies our merged $KCONFIG_NAME to linux-<ver>/.config
#   - runs make olddefconfig + bzImage
#   - bundles into libkrunfw.so.<ABI>
make -j"$(nproc)" MAKEFLAGS=""

# ── Stage the result ────────────────────────────────────────────────────────

mkdir -p "$OUT_DIR"

# libkrunfw's Makefile produces libkrunfw.so.5.<minor>.<patch> (e.g.
# libkrunfw.so.5.3.0) with a symlink chain libkrunfw.so.5 → libkrunfw.so.5.3.0.
# We copy the real file and rename it to libkrunfw-privileged.so.5 so it can sit
# next to the lean libkrunfw.so.5 in the runtime dir without a name collision.
REAL_BLOB=$(ls "$LIBKRUNFW_SRC"/libkrunfw.so.5.* 2>/dev/null | head -1 || true)
if [ -z "$REAL_BLOB" ]; then
  echo "❌ build succeeded but couldn't find libkrunfw.so.5.* in $LIBKRUNFW_SRC" >&2
  exit 1
fi

PRIVILEGED_BLOB="$OUT_DIR/libkrunfw-privileged.so.5"
cp "$REAL_BLOB" "$PRIVILEGED_BLOB"
# Rename SONAME so two side-by-side blobs (lean + privileged) don't both report
# the same identity to dlopen, which would defeat per-box selection.
patchelf --set-soname libkrunfw-privileged.so.5 "$PRIVILEGED_BLOB"

echo ""
echo "✅ Built privileged libkrunfw: $PRIVILEGED_BLOB"
echo "   Size: $(du -h "$PRIVILEGED_BLOB" | cut -f1) (vs lean: $(du -h "$REAL_BLOB" 2>/dev/null | cut -f1 || echo '?'))"
echo ""
echo "Rebuild boxlite to embed it — libkrun-sys/build.rs auto-detects this path:"
echo ""
echo "   make cli"
echo ""
echo "Then \`boxlite run --privileged\` will load this kernel instead of the lean one."
echo ""
echo "(Set BOXLITE_LIBKRUNFW_PRIVILEGED_PATH only if the blob lives outside the"
echo " workspace — e.g., CI cache, packaging sysroot.)"
