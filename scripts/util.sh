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

# Map a supported guest target triple back to its architecture. Keeping this
# validation in one place prevents the C and Rust parts of the guest build from
# silently selecting different toolchains.
target_to_arch() {
    local target="$1"

    case "$target" in
        aarch64-unknown-linux-musl)
            echo "aarch64"
            ;;
        x86_64-unknown-linux-musl)
            echo "x86_64"
            ;;
        *)
            echo "ERROR: Unsupported guest target: $target" >&2
            echo "Supported: aarch64-unknown-linux-musl, x86_64-unknown-linux-musl" >&2
            return 1
            ;;
    esac
}

is_native_linux_target() {
    local target="$1"
    local target_arch
    local host_arch

    [ "$(uname -s)" = "Linux" ] || return 1
    target_arch=$(target_to_arch "$target") || return 1
    host_arch=$(normalize_arch "$(detect_host_arch)") || return 1
    [ "$target_arch" = "$host_arch" ]
}

# Resolve the C compiler for a Linux-musl guest target. Prefer a target-prefixed
# cross compiler everywhere. A generic musl-gcc is safe only for a native Linux
# build because it always emits code for the host architecture.
resolve_musl_cc() {
    local target="$1"
    local arch
    local prefixed_cc

    arch=$(target_to_arch "$target") || return 1
    prefixed_cc="${arch}-linux-musl-gcc"
    if command -v "$prefixed_cc" >/dev/null 2>&1; then
        command -v "$prefixed_cc"
        return 0
    fi

    if is_native_linux_target "$target" && command -v musl-gcc >/dev/null 2>&1; then
        command -v musl-gcc
        return 0
    fi

    echo "ERROR: No musl C compiler found for $target" >&2
    echo "Tried: $prefixed_cc" >&2
    if [ "$(uname -s)" = "Linux" ]; then
        echo "The musl-gcc fallback is allowed only when host and target architectures match." >&2
    fi
    return 1
}

# Resolve target binutils. As with musl-gcc, host binutils are a valid fallback
# only for a native Linux target.
resolve_musl_tool() {
    local target="$1"
    local tool="$2"
    local arch
    local prefixed_tool

    case "$tool" in
        ar|ranlib|strip) ;;
        *)
            echo "ERROR: Unsupported musl tool: $tool (expected ar, ranlib, or strip)" >&2
            return 1
            ;;
    esac

    arch=$(target_to_arch "$target") || return 1
    prefixed_tool="${arch}-linux-musl-${tool}"
    if command -v "$prefixed_tool" >/dev/null 2>&1; then
        command -v "$prefixed_tool"
        return 0
    fi

    if is_native_linux_target "$target" && command -v "$tool" >/dev/null 2>&1; then
        command -v "$tool"
        return 0
    fi

    echo "ERROR: No $tool tool found for $target (tried $prefixed_tool)" >&2
    return 1
}

# Resolve and export one coherent toolchain for every guest build component.
init_musl_toolchain() {
    local target="$1"
    local linker_env

    MUSL_CC=$(resolve_musl_cc "$target") || return 1
    MUSL_AR=$(resolve_musl_tool "$target" ar) || return 1
    MUSL_RANLIB=$(resolve_musl_tool "$target" ranlib) || return 1
    MUSL_STRIP=$(resolve_musl_tool "$target" strip) || return 1
    export MUSL_CC MUSL_AR MUSL_RANLIB MUSL_STRIP

    linker_env="CARGO_TARGET_$(echo "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
    export "$linker_env=$MUSL_CC"
}

# Initialize guest target and arch variables
init_guest_vars() {
    local arch

    if [ -n "${GUEST_TARGET:-}" ]; then
        GUEST_ARCH=$(target_to_arch "$GUEST_TARGET")
    else
        arch=$(detect_host_arch)
        GUEST_TARGET=$(map_arch_to_target "$arch")
        GUEST_ARCH=$(normalize_arch "$arch")
    fi

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
    # Initialize variables
    init_guest_vars

    # If run as a command (not sourced), print the requested value
    if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
        case "${1:-}" in
            --target)
                echo "$GUEST_TARGET"
                ;;
            --arch)
                echo "$GUEST_ARCH"
                ;;
            --help|-h)
                print_help
                ;;
            "")
                # Default: print both
                echo "GUEST_TARGET=$GUEST_TARGET"
                echo "GUEST_ARCH=$GUEST_ARCH"
                ;;
            *)
                echo "ERROR: Unknown option: $1" >&2
                echo "Run with --help for usage information" >&2
                exit 1
                ;;
        esac
    fi
}

main "$@"
