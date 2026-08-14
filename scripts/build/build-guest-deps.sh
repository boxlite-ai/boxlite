#!/bin/bash
# Build static e2fsprogs tools for a musl guest.
# Usage:
#   build-guest-deps.sh --dest DIR [--target TARGET] [--profile release|debug]

set -euo pipefail

die() {
    echo "ERROR: $*" >&2
    return 1
}

host_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo x86_64 ;;
        arm64|aarch64) echo aarch64 ;;
        *) echo unsupported ;;
    esac
}

target_arch() {
    case "$1" in
        x86_64-unknown-linux-musl) echo x86_64 ;;
        aarch64-unknown-linux-musl) echo aarch64 ;;
        *) die "unsupported guest tools target: $1"; return 2 ;;
    esac
}

musl_cc() {
    local arch="$1" compiler
    compiler=$(command -v "${arch}-linux-musl-gcc" 2>/dev/null || true)
    if [ -z "$compiler" ] && [ "$arch" = "$(host_arch)" ]; then
        compiler=$(command -v musl-gcc 2>/dev/null || true)
    fi
    [ -n "$compiler" ] || {
        die "musl compiler not found for $arch"
        return 1
    }
    echo "$compiler"
}

cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [ -n "${work:-}" ]; then
        chmod -R u+w "$work" 2>/dev/null || true
        rm -rf -- "$work"
    fi
    exit "$status"
}

parse_args() {
    target="${GUEST_TARGET:-}"
    profile="${PROFILE:-release}"

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --target)
                [ "$#" -ge 2 ] || { die "--target requires a value"; return 2; }
                target="$2"
                shift 2
                ;;
            --dest)
                [ "$#" -ge 2 ] || { die "--dest requires a value"; return 2; }
                dest="$2"
                shift 2
                ;;
            --profile)
                [ "$#" -ge 2 ] || { die "--profile requires a value"; return 2; }
                profile="$2"
                shift 2
                ;;
            --help|-h)
                echo "Usage: $0 --dest DIR [--target TARGET] [--profile release|debug]"
                exit 0
                ;;
            *)
                die "unknown option: $1"
                return 2
                ;;
        esac
    done

    [ -n "$dest" ] || { die "--dest is required"; return 2; }
    [ -d "$dest" ] || { die "destination must be an existing directory: $dest"; return 2; }
    [ ! -L "$dest" ] || { die "destination must not be a symlink: $dest"; return 2; }
    dest=$(cd "$dest" && pwd -P)
    local destination_inventory
    destination_inventory=$(find "$dest" ! -path "$dest" -prune -print) || {
        die "failed to inspect destination: $dest"; return 2;
    }
    [ -z "$destination_inventory" ] || {
        die "destination must be empty: $dest"; return 2;
    }

    if [ -z "$target" ]; then
        target=$(bash "$root/scripts/util.sh" --target)
    fi
    arch=$(target_arch "$target") || return $?
    case "$profile" in
        release|debug) ;;
        *) die "unsupported profile: $profile"; return 2 ;;
    esac
}

build_tools() {
    local destination_inventory
    local source="$root/src/deps/e2fsprogs-sys/vendor/e2fsprogs"
    local util="$root/scripts/util.sh"
    [ -x "$source/configure" ] || {
        die "e2fsprogs submodule is not initialized at $source"
        return 1
    }
    [ -f "$util" ] || { die "missing build utility: $util"; return 1; }

    local cc build_cc cc_name build_cc_name headers host jobs cflags ldflags
    cc=$(musl_cc "$arch")
    build_cc=$(command -v "${BUILD_CC:-cc}") || { die "host C compiler not found"; return 1; }
    cc="$(cd "$(dirname "$cc")" && pwd -P)/$(basename "$cc")"
    build_cc="$(cd "$(dirname "$build_cc")" && pwd -P)/$(basename "$build_cc")"
    cc_name=$(basename "$cc")
    build_cc_name=$(basename "$build_cc")

    headers=$(bash "$util" --ensure-linux-headers "$arch")
    [ -f "$headers/asm/unistd.h" ] && [ -f "$headers/linux/audit.h" ] || {
        die "Linux headers are incomplete for $arch"
        return 1
    }
    headers=$(cd "$headers" && pwd -P)

    if [ "$profile" = release ]; then
        cflags='-O2 -fno-pie -ffunction-sections -fdata-sections'
        ldflags='-no-pie -Wl,--gc-sections'
    else
        cflags='-O0 -g3 -fno-omit-frame-pointer -fno-pie'
        ldflags='-no-pie'
    fi

    host="${target/-unknown/}"
    jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
    # e2fsprogs' generated configure and Makefiles do not preserve source,
    # compiler, or include paths containing shell-special characters. Build
    # through controlled aliases while writing only the two requested files into the caller's directory.
    # Preserve compiler basenames because some drivers dispatch on argv[0].
    work=$(mktemp -d /tmp/boxlite-e2fsprogs-work.XXXXXX)
    mkdir -p "$work/build" "$work/bin/target" "$work/bin/build"
    ln -s "$source" "$work/source"
    ln -s "$headers" "$work/headers"
    ln -s "$cc" "$work/bin/target/$cc_name"
    ln -s "$build_cc" "$work/bin/build/$build_cc_name"
    source="$work/source"
    headers="$work/headers"
    cc="$work/bin/target/$cc_name"
    build_cc="$work/bin/build/$build_cc_name"

    local -a configure_args=("--build=$("$source/config/config.guess")" "--host=$host" --prefix=/usr
        --enable-libuuid --enable-libblkid --enable-resizer --disable-elf-shlibs
        --disable-bsd-shlibs --disable-hardening --disable-debugfs --disable-imager
        --disable-defrag --disable-fsck --disable-e2initrd-helper --disable-uuidd
        --disable-tdb --disable-nls --disable-rpath --disable-fuse2fs --disable-backtrace
        --disable-tls --without-pthread --without-libarchive)

    echo "🔨 Building static e2fsprogs tools for $target ($profile)..."
    (
        cd "$work/build"
        env BUILD_CC="$build_cc" BUILD_CFLAGS="${BUILD_CFLAGS:-}" \
            BUILD_LDFLAGS="${BUILD_LDFLAGS:-}" CC="$cc" PKG_CONFIG=false \
            CPPFLAGS="-I$headers" CFLAGS="$cflags" CFLAGS_STLIB="$cflags" \
            LDFLAGS="$ldflags" LDFLAGS_STATIC="$ldflags -static" \
            "$source/configure" "${configure_args[@]}"
        make -j"$jobs" libs
        make -C misc -j"$jobs" mke2fs.static
        make -C resize -j"$jobs" resize2fs.static
    )

    install -m 0755 "$work/build/misc/mke2fs.static" "$dest/mke2fs"
    install -m 0755 "$work/build/resize/resize2fs.static" "$dest/resize2fs"
    bash "$util" --verify-guest-elf "$target" "$dest/mke2fs"
    bash "$util" --verify-guest-elf "$target" "$dest/resize2fs"
    destination_inventory=$(find "$dest" ! -path "$dest" -prune -print | LC_ALL=C sort) || {
        die "failed to inspect built destination: $dest"; return 1;
    }
    [ "$destination_inventory" = "$(printf '%s\n' "$dest/mke2fs" "$dest/resize2fs" | LC_ALL=C sort)" ] || {
        die "destination inventory is not exactly mke2fs and resize2fs"; return 1;
    }
    echo "✅ Guest e2fsprogs tools built: $dest"
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
root=$(cd "$script_dir/../.." && pwd -P)
target=""
profile=""
arch=""
work=""
dest=""

parse_args "$@"

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
build_tools
