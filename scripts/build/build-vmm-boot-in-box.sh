#!/usr/bin/env bash
# Build the native VMM's kernel inside a pinned BoxLite release box, for hosts without
# Linux kernel toolchains (macOS) or without the packages build-vmm-boot.sh needs.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cache="$root/target/vmm/boot/.cache"
state="$root/target/vmm/boot/.boxlite"
output="${_BOXLITE_BOOT_OUTPUT_ARG:-$root/target/vmm/boot/x86_64}"
jobs="${_BOXLITE_BOOT_JOBS_ARG:-}"
partial=
# The guest kernel bundled with the pinned BoxLite brings up at most 16 vCPUs (CONFIG_NR_CPUS).
box_max_cpus=16
box_memory_mib=4096
# A build peaks at about 2.15 GiB on the box root disk (packages, sources, objects).
box_disk_gib=4
trap '[[ -z $partial ]] || rm -f -- "$partial"' EXIT

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
    jobs=${jobs:-$(getconf _NPROCESSORS_ONLN)}
    if (( jobs > box_max_cpus )); then
        echo "note: the box kernel supports $box_max_cpus CPUs; using $box_max_cpus jobs instead of $jobs" >&2
        jobs=$box_max_cpus
    fi
}

release_target() {
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64) echo aarch64-apple-darwin ;;
        Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
        Linux-aarch64|Linux-arm64) echo aarch64-unknown-linux-gnu ;;
        *) fail "unsupported host $(uname -s) $(uname -m); BoxLite supports macOS arm64 and Linux x86_64/arm64" ;;
    esac
}

# Available host memory in MiB; neither probe needs root.
available_memory_mib() {
    if [[ $(uname -s) == Darwin ]]; then
        vm_stat | awk '/page size of/ { size = $8 }
            /^Pages (free|inactive|speculative):/ { gsub(/\./, "", $NF); pages += $NF }
            END { print int(pages * size / 1048576) }'
    else
        free -m | awk '/^Mem:/ { print $7 }'
    fi
}

# Fail before any download when the host cannot hold the box's memory or its full root disk.
check_resources() {
    local memory dir=$state free_kib
    memory=$(available_memory_mib) || true
    [[ $memory =~ ^[0-9]+$ ]] || fail "cannot read available host memory"
    (( memory >= box_memory_mib )) ||
        fail "$memory MiB of memory available; the build box needs $box_memory_mib MiB"
    [[ -d $dir ]] || dir="$root/target"
    [[ -d $dir ]] || dir=$root
    free_kib=$(df -Pk "$dir" | awk 'NR == 2 { print $4 }') || true
    [[ $free_kib =~ ^[0-9]+$ ]] || fail "cannot read free disk space on $dir"
    (( free_kib >= box_disk_gib * 1024 * 1024 )) ||
        fail "$(( free_kib / 1024 )) MiB free on $dir; the build box needs $box_disk_gib GiB"
}

# The output directory is mounted at /out. BoxLite mounts only an existing absolute host
# path; a relative one names a managed volume.
prepare_output() {
    [[ $output == /* ]] || output="$PWD/$output"
    mkdir -p -- "$output"
}

sha256() {
    local digest
    if command -v sha256sum >/dev/null; then digest=$(sha256sum -- "$1"); else digest=$(shasum -a 256 -- "$1"); fi
    echo "${digest%% *}"
}

# Download the pinned CLI next to its cache entry and rename it only after verification.
fetch_boxlite() {
    local target=$1 expected_var asset tarball
    expected_var="BOXLITE_SHA256_${target//-/_}"
    [[ -n ${!expected_var:-} ]] || fail "boxlite.lock has no SHA-256 for $target"
    asset="boxlite-cli-v$BOXLITE_VERSION-$target.tar.gz"
    tarball="$cache/$asset"
    mkdir -p "$cache"
    if [[ ! -f $tarball ]]; then
        partial="$tarball.part.$$"
        curl --fail --location --no-progress-meter --show-error --retry 3 --connect-timeout 30 --max-time 600 \
            "https://github.com/boxlite-ai/boxlite/releases/download/v$BOXLITE_VERSION/$asset" --output "$partial"
        [[ $(sha256 "$partial") == "${!expected_var}" ]] || fail "BoxLite SHA256 mismatch: $asset"
        mv -- "$partial" "$tarball"
        partial=
    fi
    [[ $(sha256 "$tarball") == "${!expected_var}" ]] || fail "BoxLite SHA256 mismatch: $tarball; remove it and retry"
    boxlite_dir="$cache/boxlite-v$BOXLITE_VERSION-$target"
    rm -rf -- "$boxlite_dir"
    mkdir -p "$boxlite_dir"
    tar -xzf "$tarball" -C "$boxlite_dir"
}

# Runs inside the box as root. The kernel sources go to the box's ext4 root disk: /tmp is
# tmpfs, and the mounted repository may be case-insensitive on macOS.
read -r -d '' inner <<'BOX' || true
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential bc bison flex curl ca-certificates \
    xz-utils libelf-dev gcc-x86-64-linux-gnu binutils-x86-64-linux-gnu >/dev/null
mkdir -p /var/tmp/boxlite-vmm-boot
TMPDIR=/var/tmp/boxlite-vmm-boot exec bash scripts/build/build-vmm-boot.sh --output /out --jobs "$1"
BOX

parse_args "$@"
target=$(release_target)
check_resources
prepare_output
source "$root/src/vmm/boot/boxlite.lock"
fetch_boxlite "$target"
# Keep this BoxLite's images, boxes, database and extracted runtime away from any other install.
export BOXLITE_HOME="$state" XDG_DATA_HOME="$state/xdg"
"$boxlite_dir/boxlite" run --rm --cpus "$jobs" --memory "$box_memory_mib" --disk-size "$box_disk_gib" \
    -v "$root:/src" -v "$output:/out" -w /src "$BUILDER_IMAGE" bash -c "$inner" bash "$jobs"
printf 'Kernel artifacts on the host: %s\n' "$output"
