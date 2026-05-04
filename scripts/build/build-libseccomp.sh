#!/bin/bash
# Build libseccomp.a statically for the guest musl target.
#
# The guest binary is statically linked with musl. The Rust `libseccomp` crate
# (pulled by libcontainer's "libseccomp" feature) needs libseccomp.a for the
# *target* triple, not the host. This script builds that .a from upstream
# source using the musl cross-compiler that build-guest.sh already requires.
#
# Output layout (cache):
#   $BOXLITE_CACHE/libseccomp/<target>/<version>/{lib,include}
#   $BOXLITE_CACHE/linux-headers/<version>/<arch>/include
#
# Default: $BOXLITE_CACHE = <project-root>/target/native
# Override: set BOXLITE_CACHE env var (e.g. CI may want a shared cache).
#
# Living under target/native/ means:
#   - per-checkout (each worktree has its own)
#   - gitignored (target/ is in .gitignore already)
#   - cleaned by `cargo clean`
#   - sibling-friendly for future vendored C deps (target/native/libcap/, etc.)
#
# On success, exports:
#   LIBSECCOMP_LIB_PATH      (consumed by libseccomp-sys build.rs)
#   LIBSECCOMP_LINK_TYPE=static
#   LIBSECCOMP_INCLUDE_PATH
#
# Usage:
#   source scripts/build/build-libseccomp.sh
#   ensure_libseccomp_for_target aarch64-unknown-linux-musl

set -e

# Default cache lives under the project's target/native/ dir (per-checkout,
# gitignored, cleaned by `cargo clean`). Resolved from this script's own
# location so it works whether sourced or run directly.
_BUILD_LIBSECCOMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_BOXLITE_CACHE="$(cd "$_BUILD_LIBSECCOMP_DIR/../.." && pwd)/target/native"

LIBSECCOMP_VERSION="${LIBSECCOMP_VERSION:-2.5.5}"
LIBSECCOMP_TARBALL_SHA256="${LIBSECCOMP_TARBALL_SHA256:-248a2c8a4d9b9858aa6baf52712c34afefcf9c9e94b76dce02c1c9aa25fb3375}"

# sabotage-linux/kernel-headers: small portable export of Linux user-space
# headers (asm/, linux/, etc.). Needed because brew's musl-cross ships
# musl libc headers but no Linux kernel headers, and libseccomp #includes
# <asm/unistd.h> and <linux/audit.h>.
LINUX_HEADERS_VERSION="${LINUX_HEADERS_VERSION:-4.19.88-2}"
LINUX_HEADERS_SHA256="${LINUX_HEADERS_SHA256:-16161844e56944d39794ad74c2dfd6faad12bda79b5dc00595f4178d28a92e2d}"

# Install Linux user-space headers for ARCH into a cache dir, return path
# to the include/ root via stdout. Idempotent.
ensure_linux_headers_for_arch() {
    local arch="$1"
    if [ -z "$arch" ]; then
        echo "ERROR: ensure_linux_headers_for_arch requires an arch (e.g. aarch64, x86_64)" >&2
        return 1
    fi

    local cache_root="${BOXLITE_CACHE:-$DEFAULT_BOXLITE_CACHE}/linux-headers/$LINUX_HEADERS_VERSION/$arch"
    local include_dir="$cache_root/include"

    if [ -f "$include_dir/asm/unistd.h" ] && [ -f "$include_dir/linux/audit.h" ]; then
        echo "$include_dir"
        return 0
    fi

    local build_root
    build_root=$(mktemp -d -t boxlite-kheaders-XXXXXX)
    # local trap so caller's trap (libseccomp build_root) isn't clobbered
    local _kheaders_cleanup="rm -rf '$build_root'"

    local tarball="$build_root/kernel-headers.tar.gz"
    local url="https://github.com/sabotage-linux/kernel-headers/archive/refs/tags/v$LINUX_HEADERS_VERSION.tar.gz"

    echo "  → downloading $url" >&2
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tarball" || { eval "$_kheaders_cleanup"; return 1; }
    else
        wget -q "$url" -O "$tarball" || { eval "$_kheaders_cleanup"; return 1; }
    fi

    local actual_sha256
    if command -v shasum >/dev/null 2>&1; then
        actual_sha256=$(shasum -a 256 "$tarball" | awk '{print $1}')
    else
        actual_sha256=$(sha256sum "$tarball" | awk '{print $1}')
    fi
    if [ "$actual_sha256" != "$LINUX_HEADERS_SHA256" ]; then
        echo "ERROR: kernel-headers tarball SHA256 mismatch" >&2
        echo "  expected: $LINUX_HEADERS_SHA256" >&2
        echo "  actual:   $actual_sha256" >&2
        eval "$_kheaders_cleanup"
        return 1
    fi

    tar -xzf "$tarball" -C "$build_root"
    mkdir -p "$cache_root"
    (
        cd "$build_root/kernel-headers-$LINUX_HEADERS_VERSION"
        make ARCH="$arch" prefix="$cache_root" install >/dev/null
    )

    eval "$_kheaders_cleanup"

    if [ ! -f "$include_dir/asm/unistd.h" ] || [ ! -f "$include_dir/linux/audit.h" ]; then
        echo "ERROR: kernel-headers install did not produce expected headers" >&2
        return 1
    fi

    echo "$include_dir"
}

ensure_libseccomp_for_target() {
    local target="$1"
    if [ -z "$target" ]; then
        echo "ERROR: ensure_libseccomp_for_target requires a target triple" >&2
        return 1
    fi

    local arch_prefix
    arch_prefix=$(echo "$target" | cut -d'-' -f1)
    local cc="${arch_prefix}-linux-musl-gcc"
    if ! command -v "$cc" >/dev/null 2>&1; then
        echo "ERROR: musl cross-compiler $cc not found in PATH" >&2
        echo "  Run scripts/setup/setup-macos.sh (or setup-ubuntu.sh / setup-musllinux.sh)" >&2
        return 1
    fi

    local cache_root="${BOXLITE_CACHE:-$DEFAULT_BOXLITE_CACHE}/libseccomp/$target/$LIBSECCOMP_VERSION"
    local lib_path="$cache_root/lib/libseccomp.a"

    if [ -f "$lib_path" ]; then
        export LIBSECCOMP_LIB_PATH="$cache_root/lib"
        export LIBSECCOMP_INCLUDE_PATH="$cache_root/include"
        export LIBSECCOMP_LINK_TYPE="static"
        return 0
    fi

    echo "🔨 Building libseccomp $LIBSECCOMP_VERSION for $target..."

    if ! command -v gperf >/dev/null 2>&1; then
        echo "ERROR: gperf not found (libseccomp build dep)" >&2
        echo "  macOS:    brew install gperf" >&2
        echo "  Ubuntu:   sudo apt-get install gperf" >&2
        echo "  Alpine:   apk add gperf" >&2
        return 1
    fi

    local build_root
    build_root=$(mktemp -d -t boxlite-libseccomp-XXXXXX)
    trap 'rm -rf "$build_root"' EXIT

    local tarball="$build_root/libseccomp-$LIBSECCOMP_VERSION.tar.gz"
    local url="https://github.com/seccomp/libseccomp/releases/download/v$LIBSECCOMP_VERSION/libseccomp-$LIBSECCOMP_VERSION.tar.gz"

    echo "  → downloading $url"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tarball"
    else
        wget -q "$url" -O "$tarball"
    fi

    # Verify integrity
    local actual_sha256
    if command -v shasum >/dev/null 2>&1; then
        actual_sha256=$(shasum -a 256 "$tarball" | awk '{print $1}')
    else
        actual_sha256=$(sha256sum "$tarball" | awk '{print $1}')
    fi
    if [ "$actual_sha256" != "$LIBSECCOMP_TARBALL_SHA256" ]; then
        echo "ERROR: libseccomp tarball SHA256 mismatch" >&2
        echo "  expected: $LIBSECCOMP_TARBALL_SHA256" >&2
        echo "  actual:   $actual_sha256" >&2
        return 1
    fi

    # libseccomp #includes <asm/unistd.h> and <linux/audit.h> which musl-cross
    # doesn't ship. Vendor portable Linux user-space headers for the target arch.
    local headers_include
    headers_include=$(ensure_linux_headers_for_arch "$arch_prefix")
    if [ -z "$headers_include" ]; then
        echo "ERROR: failed to provision Linux kernel headers for $arch_prefix" >&2
        return 1
    fi

    tar -xzf "$tarball" -C "$build_root"
    local src_dir="$build_root/libseccomp-$LIBSECCOMP_VERSION"

    mkdir -p "$cache_root"

    (
        cd "$src_dir"
        # --host tells autotools we're cross-compiling.
        # CC overrides default gcc; CFLAGS hardens; --enable-static + --disable-shared
        # gives us libseccomp.a only. CPPFLAGS points at vendored kernel headers.
        ./configure \
            --host="${arch_prefix}-linux-musl" \
            --prefix="$cache_root" \
            --enable-static \
            --disable-shared \
            --disable-python \
            CC="$cc" \
            CFLAGS="-Os -fPIC" \
            CPPFLAGS="-I$headers_include" \
            >/dev/null

        make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >/dev/null
        make install >/dev/null
    )

    if [ ! -f "$lib_path" ]; then
        echo "ERROR: libseccomp build did not produce $lib_path" >&2
        return 1
    fi

    echo "✓ libseccomp.a → $lib_path"

    export LIBSECCOMP_LIB_PATH="$cache_root/lib"
    export LIBSECCOMP_INCLUDE_PATH="$cache_root/include"
    export LIBSECCOMP_LINK_TYPE="static"
}

# When executed directly, build for $1 or auto-detected target.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    target="${1:-}"
    if [ -z "$target" ]; then
        SCRIPT_DIR_LSC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
        # shellcheck source=../util.sh
        source "$SCRIPT_DIR_LSC/util.sh"
        target="$GUEST_TARGET"
    fi
    ensure_libseccomp_for_target "$target"
    echo "LIBSECCOMP_LIB_PATH=$LIBSECCOMP_LIB_PATH"
    echo "LIBSECCOMP_INCLUDE_PATH=$LIBSECCOMP_INCLUDE_PATH"
    echo "LIBSECCOMP_LINK_TYPE=$LIBSECCOMP_LINK_TYPE"
fi
