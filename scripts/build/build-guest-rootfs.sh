#!/bin/bash
# Assemble the minimal guest rootfs directory.
# Usage: build-guest-rootfs.sh --target TARGET --profile release|debug
set -euo pipefail

die() { echo "ERROR: $*" >&2; return 1; }

portable_mode() {
    if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}

cleanup() {
    local status=$? cleanup_failed=0
    trap - EXIT HUP INT TERM
    set +e

    if [ "$status" -ne 0 ] && [ "${output_created:-0}" = 1 ] && { [ -e "$output" ] || [ -L "$output" ]; }; then
        rm -rf -- "$output" || {
            echo "ERROR: failed to remove incomplete guest rootfs: $output" >&2
            cleanup_failed=1
        }
    fi
    if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then status=1; fi
    exit "$status"
}

parse_args() {
    target=""; profile=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --target) [ "$#" -ge 2 ] || { die "--target requires a value"; return 2; }; target="$2"; shift 2 ;;
            --profile) [ "$#" -ge 2 ] || { die "--profile requires a value"; return 2; }; profile="$2"; shift 2 ;;
            --help|-h) echo "Usage: $0 --target TARGET --profile release|debug"; exit 0 ;;
            *) die "unknown option: $1"; return 2 ;;
        esac
    done
    case "$target" in
        x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;;
        *) die "unsupported guest rootfs target: $target"; return 2 ;;
    esac
    case "$profile" in release|debug) ;; *) die "unsupported profile: $profile"; return 2 ;; esac
}

find_readelf() {
    local candidate
    for candidate in "${READELF:-}" "${target%%-*}-linux-musl-readelf" llvm-readelf /opt/homebrew/opt/llvm/bin/llvm-readelf /usr/local/opt/llvm/bin/llvm-readelf readelf; do
        [ -n "$candidate" ] || continue
        command -v "$candidate" >/dev/null 2>&1 || continue
        echo "$candidate"; return 0
    done
    die "readelf or llvm-readelf is required"
}

verify_guest_binary() {
    local path="$1" machine header programs dynamic readelf_tool
    [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] && [ -x "$path" ] || die "invalid boxlite-guest input: $path"
    case "$target" in
        x86_64-unknown-linux-musl) machine='Advanced Micro Devices X86-64|AMD x86-64|X86-64|x86-64' ;;
        aarch64-unknown-linux-musl) machine='AArch64' ;;
    esac
    readelf_tool=$(find_readelf)
    header=$(LC_ALL=C "$readelf_tool" -hW "$path")
    programs=$(LC_ALL=C "$readelf_tool" -lW "$path")
    dynamic=$(LC_ALL=C "$readelf_tool" -dW "$path")
    printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF64([[:space:]]|$)' || die "boxlite-guest must be ELF64: $path"
    printf '%s\n' "$header" | grep -Eiq 'Data:[[:space:]]+2.s complement,[[:space:]]+little([ -])endian' || die "boxlite-guest must be little-endian: $path"
    printf '%s\n' "$header" | grep -Eq 'Type:[[:space:]]+(EXEC|DYN)([[:space:]]|$)' || die "boxlite-guest must be ET_EXEC or static PIE: $path"
    printf '%s\n' "$header" | grep -Eq "Machine:[[:space:]]+($machine)([[:space:]]|$)" || die "boxlite-guest architecture does not match $target: $path"
    printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])LOAD([[:space:]]|$)' || die "boxlite-guest has no loadable segment: $path"
    ! printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)' || die "boxlite-guest has a PT_INTERP segment: $path"
    ! printf '%s\n' "$dynamic" | grep -Eq '(\(NEEDED\)|(^|[[:space:]])NEEDED([[:space:]]|$))' || die "boxlite-guest has a DT_NEEDED entry: $path"
}

verify_inventory() {
    local rootfs="$1" actual expected path symlinks
    expected=$(printf '%s\n' \
        boxlite \
        boxlite/bin \
        boxlite/bin/boxlite-guest \
        boxlite/bin/mke2fs \
        boxlite/bin/resize2fs \
        dev proc run sys tmp var var/tmp)
    actual=$(cd "$rootfs" && find . ! -name . -print | sed 's#^./##' | LC_ALL=C sort)
    [ "$actual" = "$expected" ] || { printf 'ERROR: unexpected rootfs inventory\n%s\n' "$actual" >&2; return 1; }
    for path in \
        "$rootfs" \
        "$rootfs/boxlite" \
        "$rootfs/boxlite/bin" \
        "$rootfs/dev" \
        "$rootfs/proc" \
        "$rootfs/run" \
        "$rootfs/sys" \
        "$rootfs/tmp" \
        "$rootfs/var" \
        "$rootfs/var/tmp"
    do
        [ -d "$path" ] && [ ! -L "$path" ] && [ "$(portable_mode "$path")" = 755 ] || die "invalid 0755 rootfs directory: $path"
    done
    for path in "$rootfs/boxlite/bin/boxlite-guest" "$rootfs/boxlite/bin/mke2fs" "$rootfs/boxlite/bin/resize2fs"; do
        [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] && [ "$(portable_mode "$path")" = 755 ] || die "invalid 0755 rootfs file: $path"
    done
    if ! symlinks=$(find "$rootfs" -type l -print); then
        die "failed to inspect guest rootfs for symlinks: $rootfs"; return 1
    fi
    [ -z "$symlinks" ] || die "guest rootfs must not contain symlinks"
}

main() {
    local top_level
    parse_args "$@"
    output_parent="$root/target/$target/$profile"
    output="$output_parent/guest-rootfs"
    guest_binary="$output_parent/boxlite-guest"
    mkdir -p "$output_parent"
    verify_guest_binary "$guest_binary"

    rm -rf -- "$output"
    output_created=1
    mkdir -p \
        "$output/rootfs/boxlite/bin" \
        "$output/rootfs/dev" \
        "$output/rootfs/proc" \
        "$output/rootfs/run" \
        "$output/rootfs/sys" \
        "$output/rootfs/tmp" \
        "$output/rootfs/var/tmp"
    chmod 0755 \
        "$output" \
        "$output/rootfs" \
        "$output/rootfs/boxlite" \
        "$output/rootfs/boxlite/bin" \
        "$output/rootfs/dev" \
        "$output/rootfs/proc" \
        "$output/rootfs/run" \
        "$output/rootfs/sys" \
        "$output/rootfs/tmp" \
        "$output/rootfs/var" \
        "$output/rootfs/var/tmp"

    bash "$script_dir/build-guest-deps.sh" \
        --target "$target" \
        --profile "$profile" \
        --dest "$output/rootfs/boxlite/bin"
    install -m 0755 "$guest_binary" "$output/rootfs/boxlite/bin/boxlite-guest"

    cmp -s "$guest_binary" "$output/rootfs/boxlite/bin/boxlite-guest" || die "rootfs guest differs from standalone input"
    verify_guest_binary "$output/rootfs/boxlite/bin/boxlite-guest"
    bash "$root/scripts/util.sh" --verify-guest-elf "$target" "$output/rootfs/boxlite/bin/mke2fs"
    bash "$root/scripts/util.sh" --verify-guest-elf "$target" "$output/rootfs/boxlite/bin/resize2fs"
    verify_inventory "$output/rootfs"
    top_level=$(cd "$output" && find . ! -name . -prune -print | sed 's#^./##')
    [ "$top_level" = rootfs ] || die "guest rootfs output must contain only rootfs"
    echo "Guest rootfs built: $output"
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
root=$(cd "$script_dir/../.." && pwd -P)
target=""; profile=""; output_parent=""; output=""; guest_binary=""
output_created=0
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
main "$@"
