#!/usr/bin/env bash
# Build the native VMM's x86_64 first-boot artifacts with Linux host tools.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
inputs="$root/src/vmm/boot"
cache="$root/target/vmm/boot/.cache"
output="${_BOXLITE_BOOT_OUTPUT_ARG:-$root/target/vmm/boot/x86_64}"
jobs="${_BOXLITE_BOOT_JOBS_ARG:-}"
work= stage= backup= child_pid=
artifacts=(vmlinux bzImage test-initramfs.cpio kernel.config build-info.txt)

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
        make bc bison flex curl xz tar perl readelf sha256sum flock setsid realpath; do
        command -v "$tool" >/dev/null || fail "missing $tool; see src/vmm/boot/README.md for prerequisites"
    done
    [[ $(x86_64-linux-gnu-gcc -dumpmachine) == x86_64*-linux-gnu* ]] ||
        fail "x86_64-linux-gnu-gcc must target x86_64 Linux"
    libc=$(x86_64-linux-gnu-gcc -print-file-name=libc.a)
    [[ -f $libc ]] || fail "static x86_64 libc missing; install the target C development libraries"
    jobs=${jobs:-$(getconf _NPROCESSORS_ONLN)}
}

check_output() {
    [[ ! -L $output ]] || fail "output must not be a symlink: $output"
    [[ ! -e $output || -d $output ]] || fail "output is not a directory: $output"
    local path name
    shopt -s nullglob dotglob
    for path in "$output"/*; do
        name=${path##*/}
        case "$name" in
            vmlinux|bzImage|test-initramfs.cpio|kernel.config|build-info.txt|SHA256SUMS) ;;
            *) fail "output directory contains an unrelated entry: $path" ;;
        esac
        [[ -f $path && ! -L $path ]] || fail "unsafe output entry: $path"
    done
    output=$(realpath -m -- "$output")
}

cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    set +e
    if [[ -n $child_pid ]]; then
        kill -KILL -- "-$child_pid" 2>/dev/null
        wait "$child_pid" 2>/dev/null
    fi
    if [[ -n $backup && -d $backup/artifacts && ! -e $output ]]; then
        mv -- "$backup/artifacts" "$output" || {
            printf 'ERROR: previous artifacts retained in %s\n' "$backup/artifacts" >&2
            backup=
            status=1
        }
    fi
    local path
    for path in "$work" "$stage" "$backup"; do
        [[ -n $path ]] || continue
        rm -rf -- "$path" || { printf 'ERROR: cleanup failed: %s\n' "$path" >&2; status=1; }
    done
    exit "$status"
}

run() {
    # Keep the build tree alive until every compiler/download subprocess is gone.
    setsid -- "$@" &
    child_pid=$!
    local status=0
    wait "$child_pid" || status=$?
    child_pid=
    return "$status"
}

prepare() {
    mkdir -p "$cache"
    exec 9>"$cache/build.lock"
    flock -n 9 || fail "another VMM boot build is running in this checkout"
    work=$(mktemp -d /tmp/boxlite-vmm-boot.XXXXXXXX)
    trap cleanup EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    umask 022
    mkdir "$work/inputs" "$work/build"
    cp "$inputs/kernel.lock" "$inputs/kernel.config" "$inputs/init.c" "$work/inputs/"
    source "$work/inputs/kernel.lock"
    export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH
    export KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=builder KBUILD_BUILD_VERSION=1
    KBUILD_BUILD_TIMESTAMP=$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M:%S UTC')
    export KBUILD_BUILD_TIMESTAMP
    # Do not inherit the parent Make invocation's jobserver or command-line variables.
    unset MAKEFLAGS MFLAGS MAKEOVERRIDES
    printf '#include <libelf.h>\n#include <openssl/ssl.h>\n' |
        gcc -x c -c -o "$work/host-headers.o" - ||
        fail "host headers missing; install libelf-dev and libssl-dev"
    run x86_64-linux-gnu-gcc -static -Os -Wall -Wextra -Werror \
        "-ffile-prefix-map=$work/inputs=." -Wl,--build-id=none \
        "$work/inputs/init.c" -o "$work/init"
    verify_elf "$work/init"
    local programs dynamic
    programs=$(readelf -lW "$work/init")
    dynamic=$(readelf -dW "$work/init")
    [[ $programs != *INTERP* && $dynamic != *NEEDED* ]] || fail "init must be statically linked"
}

verify_elf() {
    local header
    header=$(readelf -hW "$1")
    [[ $header == *ELF64* && $header == *'Advanced Micro Devices X86-64'* ]] ||
        fail "expected x86_64 ELF64: $1"
}

verify_tarball() {
    local digest
    digest=$(sha256sum -- "$1")
    [[ ${digest%% *} == "$KERNEL_SHA256" ]] || fail "kernel SHA256 mismatch: $1; remove the cached tarball and retry"
}

extract_kernel() {
    local tarball="$cache/linux-$KERNEL_VERSION.tar.xz"
    if [[ ! -f $tarball ]]; then
        run curl --fail --location --show-error --retry 3 --connect-timeout 30 \
            --max-time 600 --retry-max-time 900 \
            "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" \
            --output "$work/download.tar.xz"
        verify_tarball "$work/download.tar.xz"
        mv -- "$work/download.tar.xz" "$tarball"
    fi
    verify_tarball "$tarball"
    run tar -xJf "$tarball" -C "$work"
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

build_kernel() {
    local flags="-ffile-prefix-map=$work=. -fdebug-prefix-map=$work=."
    local -a kernel_make=(make -C "$work/linux-$KERNEL_VERSION" "O=$work/build"
        ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- HOSTCC=gcc CC=x86_64-linux-gnu-gcc
        "KCFLAGS=$flags" "HOSTCFLAGS=-O2 $flags")
    run "${kernel_make[@]}" "KCONFIG_ALLCONFIG=$work/inputs/kernel.config" allnoconfig
    check_config
    run "${kernel_make[@]}" -j"$jobs" vmlinux bzImage
    verify_elf "$work/build/vmlinux"
    printf 'dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\nfile /init init 0755 0 0\n' > "$work/initramfs.list"
    (cd "$work" && ./build/usr/gen_init_cpio -t "$SOURCE_DATE_EPOCH" initramfs.list) > "$work/test-initramfs.cpio"
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
    digest=$(sha256sum -- "$libc")
    printf 'libc_sha256=%s\n' "${digest%% *}"
    (cd "$work/inputs" && sha256sum kernel.lock kernel.config init.c)
    digest=$(sha256sum -- "$root/scripts/build/build-vmm-boot.sh")
    printf '%s  build-vmm-boot.sh\n' "${digest%% *}"
}

publish() {
    mkdir -p -- "$(dirname "$output")"
    stage=$(mktemp -d "$(dirname "$output")/.boxlite-boot.XXXXXXXX")
    install -m 0644 "$work/build/vmlinux" "$stage/vmlinux"
    install -m 0644 "$work/build/arch/x86/boot/bzImage" "$stage/bzImage"
    install -m 0644 "$work/build/.config" "$stage/kernel.config"
    install -m 0644 "$work/test-initramfs.cpio" "$stage/test-initramfs.cpio"
    write_metadata > "$stage/build-info.txt"
    local artifact
    for artifact in "${artifacts[@]}"; do [[ -s $stage/$artifact ]] || fail "empty artifact: $artifact"; done
    (cd "$stage" && sha256sum "${artifacts[@]}" > SHA256SUMS)
    check_output
    if [[ -d $output ]]; then
        backup=$(mktemp -d "$(dirname "$output")/.boxlite-boot-old.XXXXXXXX")
        mv -- "$output" "$backup/artifacts"
    fi
    mv -- "$stage" "$output"
    stage=
    printf 'Built VMM boot artifacts: %s\n' "$output"
}

parse_args "$@"
check_host
check_output
prepare
extract_kernel
build_kernel
publish
