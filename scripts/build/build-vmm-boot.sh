#!/usr/bin/env bash
# Build the native VMM's pinned x86_64 Linux kernel (ELF vmlinux) with Linux host tools.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
inputs="$root/src/vmm/boot"
cache="$root/target/vmm/boot/.cache"
output="${_BOXLITE_BOOT_OUTPUT_ARG:-$root/target/vmm/boot/x86_64}"
jobs="${_BOXLITE_BOOT_JOBS_ARG:-}"
work= partial=
artifacts=(vmlinux kernel.config build-info.txt)

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() { echo "Usage: $0 [--output DIR] [--jobs N]"; }

parse_args() {
    while (( $# )); do
        case "$1" in
            --output|--jobs)
                [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
                if [[ $1 == --output ]]; then output=$2; else jobs=$2; fi
                shift 2 ;;
            --help|-h) usage; exit 0 ;;
            *) fail "unknown argument: $1 (use --help)" ;;
        esac
    done
    [[ -z $jobs || $jobs =~ ^[1-9][0-9]*$ ]] || fail "--jobs must be a positive integer"
}

check_host() {
    [[ $(uname -s) == Linux ]] || fail "Linux host required; on macOS use a Linux VM"
    local tool
    for tool in gcc x86_64-linux-gnu-gcc x86_64-linux-gnu-ld x86_64-linux-gnu-as \
        make bc bison flex curl xz tar perl readelf sha256sum; do
        command -v "$tool" >/dev/null || fail "missing $tool; see src/vmm/boot/README.md for prerequisites"
    done
    [[ $(x86_64-linux-gnu-gcc -dumpmachine) == x86_64*-linux-gnu* ]] ||
        fail "x86_64-linux-gnu-gcc must target x86_64 Linux"
    [[ ! -e $output || -d $output ]] || fail "output is not a directory: $output"
    jobs=${jobs:-$(getconf _NPROCESSORS_ONLN)}
}

cleanup() {
    local status=$? path
    trap - EXIT
    for path in "$work" "$partial"; do
        [[ -z $path ]] || rm -rf -- "$path" || { printf 'ERROR: cleanup failed: %s\n' "$path" >&2; status=1; }
    done
    exit "$status"
}

prepare() {
    mkdir -p "$cache"
    work=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-vmm-boot.XXXXXXXX")
    trap cleanup EXIT
    trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
    umask 022
    mkdir "$work/inputs" "$work/build"
    cp "$inputs/kernel.lock" "$inputs/kernel.config" "$work/inputs/"
    source "$work/inputs/kernel.lock"
    export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH
    export KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=builder KBUILD_BUILD_VERSION=1
    KBUILD_BUILD_TIMESTAMP=$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M:%S UTC')
    export KBUILD_BUILD_TIMESTAMP
    # Do not inherit the parent Make invocation's jobserver or command-line variables.
    unset MAKEFLAGS MFLAGS MAKEOVERRIDES
    # objtool, selected by CONFIG_UNWINDER_ORC, needs the libelf headers and library.
    printf '#include <libelf.h>\nint main(void) { return elf_version(EV_CURRENT) == EV_NONE; }\n' |
        gcc -x c -o "$work/libelf-probe" - -lelf ||
        fail "libelf development files missing; install libelf-dev"
}

verify_tarball() {
    local digest
    digest=$(sha256sum -- "$1")
    [[ ${digest%% *} == "$KERNEL_SHA256" ]] || fail "kernel SHA256 mismatch: $1; remove the cached tarball and retry"
}

extract_kernel() {
    local tarball="$cache/linux-$KERNEL_VERSION.tar.xz"
    if [[ ! -f $tarball ]]; then
        # Download beside the cache entry so the final move is an atomic rename.
        partial="$cache/.linux-$KERNEL_VERSION.tar.xz.part.$$"
        curl --fail --location --no-progress-meter --show-error --retry 3 \
            --connect-timeout 30 --max-time 600 --retry-max-time 900 \
            "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" \
            --output "$partial"
        verify_tarball "$partial"
        mv -- "$partial" "$tarball"
        partial=
    fi
    verify_tarball "$tarball"
    tar -xJf "$tarball" -C "$work"
}

check_config() {
    local setting symbol
    while IFS= read -r setting; do
        case "$setting" in
            CONFIG_*=*) grep -Fxq -- "$setting" "$work/build/.config" ||
                fail "Kconfig did not retain $setting" ;;
            '# CONFIG_'*' is not set')
                symbol=${setting#\# }; symbol=${symbol% is not set}
                if grep -q "^$symbol=" "$work/build/.config"; then
                    fail "Kconfig enabled forbidden setting $symbol"
                fi ;;
        esac
    done < "$work/inputs/kernel.config"
}

verify_elf() {
    local header entry= expected
    header=$(readelf -hW "$1")
    [[ $header == *ELF64* && $header == *'Advanced Micro Devices X86-64'* ]] ||
        fail "expected x86_64 ELF64: $1"
    [[ $header =~ Entry\ point\ address:\ +(0x[0-9a-f]+) ]] && entry=${BASH_REMATCH[1]}
    expected=$(grep -m1 '^CONFIG_PHYSICAL_START=' "$work/build/.config")
    [[ -n $expected && $entry == "${expected#*=}" ]] ||
        fail "unexpected kernel entry $entry; expected ${expected#*=}: $1"
}

build_kernel() {
    local -a kernel_make=(make -C "$work/linux-$KERNEL_VERSION" "O=$work/build"
        ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- HOSTCC=gcc CC=x86_64-linux-gnu-gcc
        "KCFLAGS=-ffile-prefix-map=$work=.")
    "${kernel_make[@]}" "KCONFIG_ALLCONFIG=$work/inputs/kernel.config" allnoconfig
    check_config
    "${kernel_make[@]}" -j"$jobs" vmlinux
    verify_elf "$work/build/vmlinux"
}

write_metadata() {
    local tool version digest
    printf 'kernel_version=%s\nkernel_sha256=%s\nsource_date_epoch=%s\n' \
        "$KERNEL_VERSION" "$KERNEL_SHA256" "$SOURCE_DATE_EPOCH"
    printf 'host_arch=%s\ntarget=x86_64-linux-gnu\n' "$(uname -m)"
    for tool in gcc x86_64-linux-gnu-gcc x86_64-linux-gnu-ld make; do
        version=$("$tool" --version)
        printf '%s=%s\n' "$tool" "${version%%$'\n'*}"
    done
    (cd "$work/inputs" && sha256sum kernel.lock kernel.config)
    digest=$(sha256sum -- "$root/scripts/build/build-vmm-boot.sh")
    printf '%s  build-vmm-boot.sh\n' "${digest%% *}"
}

publish() {
    local stage="$work/stage" artifact
    mkdir "$stage"
    install -m 0644 "$work/build/vmlinux" "$stage/vmlinux"
    install -m 0644 "$work/build/.config" "$stage/kernel.config"
    write_metadata > "$stage/build-info.txt"
    for artifact in "${artifacts[@]}"; do [[ -s $stage/$artifact ]] || fail "empty artifact: $artifact"; done
    (cd "$stage" && sha256sum "${artifacts[@]}" > SHA256SUMS)
    # Only the artifact names are written; other entries in the output directory are left alone.
    mkdir -p -- "$output"
    install -m 0644 "$stage"/* "$output/"
    printf 'Built VMM kernel: %s/vmlinux\n' "$output"
}

parse_args "$@"
check_host
prepare
extract_kernel
build_kernel
publish
