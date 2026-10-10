#!/usr/bin/env bash
# Build the native VMM's pinned x86_64 Linux kernel (ELF vmlinux) with Linux host tools.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
inputs="$root/src/vmm/boot"
cache="$root/target/vmm/boot/.cache"
output="${_BOXLITE_BOOT_OUTPUT_ARG:-$root/target/vmm/boot/x86_64}"
jobs="${_BOXLITE_BOOT_JOBS_ARG:-}"
work= stage= backup= partial= child_pid=
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
    [[ $(uname -s) == Linux ]] || fail "Linux host required; use make vmm:boot to build inside a BoxLite box"
    local tool
    for tool in gcc x86_64-linux-gnu-gcc x86_64-linux-gnu-ld x86_64-linux-gnu-as \
        make bc bison flex curl xz tar perl readelf sha256sum flock setsid realpath; do
        command -v "$tool" >/dev/null || fail "missing $tool; see src/vmm/boot/README.md for prerequisites"
    done
    [[ $(x86_64-linux-gnu-gcc -dumpmachine) == x86_64*-linux-gnu* ]] ||
        fail "x86_64-linux-gnu-gcc must target x86_64 Linux"
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
            vmlinux|kernel.config|build-info.txt|SHA256SUMS) ;;
            *) fail "output directory contains an unrelated entry: $path" ;;
        esac
        [[ -f $path && ! -L $path ]] || fail "unsafe output entry: $path"
    done
    output=$(realpath -m -- "$output")
}

cleanup() {
    local status=$? path
    trap - EXIT
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
    for path in "$work" "$stage" "$backup" "$partial"; do
        [[ -z $path ]] || rm -rf -- "$path" || { printf 'ERROR: cleanup failed: %s\n' "$path" >&2; status=1; }
    done
    exit "$status"
}

run() {
    # Each child gets its own session so cleanup can kill the whole tree; the lock
    # descriptor stays with this process only.
    setsid -- "$@" 9>&- &
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
        run curl --fail --location --no-progress-meter --show-error --retry 3 \
            --connect-timeout 30 --max-time 600 --retry-max-time 900 \
            "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" \
            --output "$partial"
        verify_tarball "$partial"
        mv -- "$partial" "$tarball"
        partial=
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
    run "${kernel_make[@]}" "KCONFIG_ALLCONFIG=$work/inputs/kernel.config" allnoconfig
    check_config
    run "${kernel_make[@]}" -j"$jobs" vmlinux
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
    local artifact
    mkdir -p -- "$(dirname "$output")"
    stage=$(mktemp -d "$(dirname "$output")/.boxlite-boot.XXXXXXXX")
    chmod 0755 "$stage"
    install -m 0644 "$work/build/vmlinux" "$stage/vmlinux"
    install -m 0644 "$work/build/.config" "$stage/kernel.config"
    write_metadata > "$stage/build-info.txt"
    for artifact in "${artifacts[@]}"; do [[ -s $stage/$artifact ]] || fail "empty artifact: $artifact"; done
    (cd "$stage" && sha256sum "${artifacts[@]}" > SHA256SUMS)
    check_output
    # Swap the staged directory in by rename; the previous output survives any failure.
    if [[ -d $output ]]; then
        backup=$(mktemp -d "$(dirname "$output")/.boxlite-boot-old.XXXXXXXX")
        mv -- "$output" "$backup/artifacts"
    fi
    mv -- "$stage" "$output"
    stage=
    printf 'Built VMM kernel: %s/vmlinux\n' "$output"
}

parse_args "$@"
check_host
check_output
prepare
extract_kernel
build_kernel
publish
