#!/bin/bash
# Build utility functions for BoxLite scripts
#
# This script provides utility functions for architecture detection,
# platform detection, and other common build tasks.
#
# Usage:
#   source scripts/util.sh
#   echo "Building for $GUEST_TARGET"
#
# Or as a command:
#   GUEST_TARGET=$(scripts/util.sh --target)
#   scripts/util.sh --verify-guest-elf <target> <path>
#   scripts/util.sh --ensure-linux-headers <x86_64|aarch64>

set -e

# Detect host architecture
detect_host_arch() {
    uname -m
}

# Map architecture to Linux musl target triple
map_arch_to_target() {
    local arch="$1"

    case "$arch" in
        arm64|aarch64)
            echo "aarch64-unknown-linux-musl"
            ;;
        x86_64|amd64)
            echo "x86_64-unknown-linux-musl"
            ;;
        *)
            echo "ERROR: Unsupported architecture: $arch" >&2
            echo "Supported: arm64, aarch64, x86_64, amd64" >&2
            return 1
            ;;
    esac
}

# Normalize architecture name
normalize_arch() {
    local arch="$1"

    case "$arch" in
        arm64|aarch64)
            echo "aarch64"
            ;;
        x86_64|amd64)
            echo "x86_64"
            ;;
        *)
            echo "ERROR: Unsupported architecture: $arch" >&2
            return 1
            ;;
    esac
}

# Validate a static, non-PIE Linux guest executable.
verify_guest_elf() {
    [ "$#" -eq 2 ] || { echo "ERROR: verify_guest_elf requires <target> <path>" >&2; return 2; }
    local LC_ALL=C target="$1" elf_path="$2" machine readelf_tool candidate
    export LC_ALL
    case "$target" in
        x86_64-unknown-linux-musl) machine='Advanced Micro Devices X86-64|AMD x86-64|X86-64|x86-64' ;;
        aarch64-unknown-linux-musl) machine=AArch64 ;;
        *) echo "ERROR: unsupported guest target for ELF verification: $target" >&2; return 2 ;;
    esac
    [ -f "$elf_path" ] || { echo "ERROR: guest ELF does not exist: $elf_path" >&2; return 1; }
    [ -s "$elf_path" ] || { echo "ERROR: guest ELF is empty: $elf_path" >&2; return 1; }
    [ -x "$elf_path" ] || { echo "ERROR: guest ELF is not executable: $elf_path" >&2; return 1; }

    readelf_tool="${READELF:-}"
    if [ -z "$readelf_tool" ]; then
        for candidate in \
            "${target%%-*}-linux-musl-readelf" llvm-readelf \
            /opt/homebrew/opt/llvm/bin/llvm-readelf \
            /usr/local/opt/llvm/bin/llvm-readelf readelf; do
            command -v "$candidate" >/dev/null 2>&1 || continue
            readelf_tool="$candidate"
            break
        done
    fi
    command -v "$readelf_tool" >/dev/null 2>&1 || {
        echo "ERROR: readelf or llvm-readelf is required to verify $elf_path" >&2
        return 1
    }

    local header programs sections dynamic
    header=$("$readelf_tool" -hW "$elf_path" 2>&1) || {
        echo "ERROR: failed to read ELF header for $elf_path" >&2; echo "$header" >&2; return 1;
    }
    programs=$("$readelf_tool" -lW "$elf_path" 2>&1) || {
        echo "ERROR: failed to read ELF program headers for $elf_path" >&2; echo "$programs" >&2; return 1;
    }
    sections=$("$readelf_tool" -SW "$elf_path" 2>&1) || {
        echo "ERROR: failed to read ELF section headers for $elf_path" >&2; echo "$sections" >&2; return 1;
    }
    printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF64([[:space:]]|$)' || {
        echo "ERROR: guest executable must be ELF64: $elf_path" >&2; return 1;
    }
    printf '%s\n' "$header" | grep -Eiq 'Data:[[:space:]]+2.s complement,[[:space:]]+little([ -])endian' || {
        echo "ERROR: guest executable must be little-endian: $elf_path" >&2; return 1;
    }
    printf '%s\n' "$header" | grep -Eq 'Type:[[:space:]]+EXEC([[:space:]]|$)' || {
        echo "ERROR: guest executable must be non-PIE ET_EXEC: $elf_path" >&2; return 1;
    }
    printf '%s\n' "$header" | grep -Eq "Machine:[[:space:]]+($machine)([[:space:]]|$)" || {
        echo "ERROR: guest executable machine does not match $target: $elf_path" >&2; return 1;
    }
    printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])LOAD([[:space:]]|$)' || {
        echo "ERROR: guest executable has no loadable program segment: $elf_path" >&2; return 1;
    }
    if printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)'; then
        echo "ERROR: guest executable has a PT_INTERP segment: $elf_path" >&2; return 1
    fi
    if printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])DYNAMIC([[:space:]]|$)'; then
        echo "ERROR: guest executable has a PT_DYNAMIC segment: $elf_path" >&2; return 1
    fi
    printf '%s\n' "$sections" | grep -Eq '(^|[[:space:]])(NULL|PROGBITS|NOBITS|NOTE|STRTAB|SYMTAB)([[:space:]]|$)' || {
        echo "ERROR: guest executable has no recognizable ELF section table: $elf_path" >&2; return 1;
    }
    if printf '%s\n' "$sections" | grep -Eq '^[[:space:]]*\[[[:space:]]*[0-9]+\][[:space:]]+([^[:space:]]+[[:space:]]+)?DYNAMIC([[:space:]]|$)'; then
        echo "ERROR: guest executable has an SHT_DYNAMIC section: $elf_path" >&2; return 1
    fi
    dynamic=$("$readelf_tool" -dW "$elf_path" 2>&1) || {
        echo "ERROR: failed to inspect the ELF dynamic table for $elf_path" >&2; echo "$dynamic" >&2; return 1;
    }
    if printf '%s\n' "$dynamic" | grep -Eq '(\(NEEDED\)|(^|[[:space:]])NEEDED([[:space:]]|$))'; then
        echo "ERROR: guest executable has a DT_NEEDED entry: $elf_path" >&2; return 1
    fi
}

# Install portable Linux user-space headers into the native dependency cache.
# Run in a subshell so its cleanup trap cannot affect callers that source util.sh.
ensure_linux_headers_for_arch() (
    [ "$#" -eq 1 ] || {
        echo "ERROR: ensure_linux_headers_for_arch requires <x86_64|aarch64>" >&2
        return 2
    }

    local arch="$1"
    case "$arch" in
        x86_64|aarch64) ;;
        *)
            echo "ERROR: unsupported architecture for Linux headers: $arch" >&2
            return 2
            ;;
    esac

    local script_dir project_root default_cache headers_version expected_sha256
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    project_root="$(cd "$script_dir/.." && pwd)"
    default_cache="$project_root/target/native"
    headers_version="${LINUX_HEADERS_VERSION:-4.19.88-2}"
    expected_sha256="${LINUX_HEADERS_SHA256:-16161844e56944d39794ad74c2dfd6faad12bda79b5dc00595f4178d28a92e2d}"

    local cache_base="${BOXLITE_CACHE:-$default_cache}"
    case "$cache_base" in
        /*) ;;
        *) cache_base="$PWD/$cache_base" ;;
    esac
    local cache_root="$cache_base/linux-headers/$headers_version/$arch"
    local include_dir="$cache_root/include"

    if [ -f "$include_dir/asm/unistd.h" ] && [ -f "$include_dir/linux/audit.h" ]; then
        echo "$include_dir"
        return 0
    fi

    local build_root
    build_root=$(mktemp -d /tmp/boxlite-kheaders.XXXXXX)
    trap 'rm -rf "$build_root"' EXIT

    local tarball="$build_root/kernel-headers.tar.gz"
    local url="https://github.com/sabotage-linux/kernel-headers/archive/refs/tags/v$headers_version.tar.gz"

    echo "  → downloading $url" >&2
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tarball"
    else
        wget -q "$url" -O "$tarball"
    fi

    local actual_sha256
    if command -v shasum >/dev/null 2>&1; then
        actual_sha256=$(shasum -a 256 "$tarball" | awk '{print $1}')
    else
        actual_sha256=$(sha256sum "$tarball" | awk '{print $1}')
    fi
    if [ "$actual_sha256" != "$expected_sha256" ]; then
        echo "ERROR: kernel-headers tarball SHA256 mismatch" >&2
        echo "  expected: $expected_sha256" >&2
        echo "  actual:   $actual_sha256" >&2
        return 1
    fi

    tar -xzf "$tarball" -C "$build_root"
    local install_root="$build_root/install"
    mkdir -p "$install_root"
    (
        cd "$build_root/kernel-headers-$headers_version"
        make ARCH="$arch" prefix="$install_root" install >/dev/null
    )
    mkdir -p "$cache_root"
    cp -R "$install_root/." "$cache_root/"

    if [ ! -f "$include_dir/asm/unistd.h" ] || [ ! -f "$include_dir/linux/audit.h" ]; then
        echo "ERROR: kernel-headers install did not produce expected headers" >&2
        return 1
    fi

    echo "$include_dir"
)

# Initialize guest target and arch variables
init_guest_vars() {
    local arch=$(detect_host_arch)
    GUEST_TARGET=$(map_arch_to_target "$arch")
    GUEST_ARCH=$(normalize_arch "$arch")

    # Export for use in other scripts
    export GUEST_TARGET
    export GUEST_ARCH
}

# Print help message
print_help() {
    cat <<EOF
Usage: util.sh [OPTION]

Build utility functions for BoxLite scripts.

Options:
  --target    Print the full Rust target triple (e.g., aarch64-unknown-linux-musl)
  --arch      Print just the architecture (e.g., aarch64)
  --verify-guest-elf <target> <path>
              Validate a static, non-PIE guest ELF executable
  --ensure-linux-headers <x86_64|aarch64>
              Print the cached Linux user-space headers include path
  --help      Show this help message

When sourced, sets environment variables:
  GUEST_TARGET    Full Rust target triple
  GUEST_ARCH      Architecture name

Examples:
  # Source in a script:
  source scripts/util.sh
  cargo build --target \$GUEST_TARGET

  # Use as a command:
  GUEST_TARGET=\$(scripts/util.sh --target)
  echo "Building for \$GUEST_TARGET"

EOF
}

# Main execution
main() {
    # If run as a command (not sourced), print the requested value
    if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
        case "${1:-}" in
            --verify-guest-elf)
                shift
                [ "$#" -eq 2 ] || {
                    echo "Usage: $0 --verify-guest-elf <target> <path>" >&2
                    return 2
                }
                verify_guest_elf "$1" "$2"
                ;;
            --ensure-linux-headers)
                shift
                [ "$#" -eq 1 ] || {
                    echo "Usage: $0 --ensure-linux-headers <x86_64|aarch64>" >&2
                    return 2
                }
                ensure_linux_headers_for_arch "$1"
                ;;
            --target)
                init_guest_vars
                echo "$GUEST_TARGET"
                ;;
            --arch)
                init_guest_vars
                echo "$GUEST_ARCH"
                ;;
            --help|-h)
                init_guest_vars
                print_help
                ;;
            "")
                # Default: print both
                init_guest_vars
                echo "GUEST_TARGET=$GUEST_TARGET"
                echo "GUEST_ARCH=$GUEST_ARCH"
                ;;
            *)
                init_guest_vars
                echo "ERROR: Unknown option: $1" >&2
                echo "Run with --help for usage information" >&2
                exit 1
                ;;
        esac
    else
        # Preserve the source API: sourcing initializes and exports both values.
        init_guest_vars
    fi
}

main "$@"
