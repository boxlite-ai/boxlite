#!/bin/bash
# Universal script to build boxlite-shim binary on macOS or Linux
#
# Usage:
#   ./build-shim.sh [--dest-dir DIR]
#
# Options:
#   --dest-dir DIR    Directory to copy the shim binary to
#   --profile PROFILE   Build profile: release or debug (default: release)
#
# Note: On macOS, the binary is automatically signed with hypervisor entitlements
# Note: On Linux, the binary is statically linked using glibc (crt-static).
#       Go c-archive is incompatible with musl TLS, so we use glibc static linking instead.

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Capture original working directory before any cd commands
ORIG_DIR="$(pwd)"

# Parse command-line arguments
parse_args() {
    DEST_DIR_ARG=""
    PROFILE="release"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --dest-dir)
                DEST_DIR_ARG="$2"
                shift 2
                ;;
            --profile)
                PROFILE="$2"
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--dest-dir DIR]"
                exit 1
                ;;
        esac
    done

    # Validate PROFILE value
    if [ "$PROFILE" != "release" ] && [ "$PROFILE" != "debug" ]; then
        echo "Invalid profile: $PROFILE"
        echo "Run with --profile release or --profile debug"
        exit 1
    fi

    # Resolve destination path to absolute path
    if [ -n "$DEST_DIR_ARG" ]; then
        # If relative, make it absolute relative to original working directory
        if [[ "$DEST_DIR_ARG" != /* ]]; then
            DEST_DIR="$ORIG_DIR/$DEST_DIR_ARG"
        else
            DEST_DIR="$DEST_DIR_ARG"
        fi
    else
        DEST_DIR=""
    fi
}

parse_args "$@"

# Detect OS
OS=$(detect_os)
print_header "🚀 Building boxlite-shim on $OS..."

SHIM_BINARY_PATH="$PROJECT_ROOT/target/$PROFILE/boxlite-shim"

# Build the shim binary
build_shim_binary() {
    cd "$PROJECT_ROOT"
    echo "🔨 Building shim binary $PROFILE..."
    local build_flag=""
    if [ "$PROFILE" = "release" ]; then
        build_flag="--release"
    fi

    if [ "$OS" = "linux" ]; then
        # Go c-archive crashes with musl TLS; use glibc + crt-static instead.
        # relocation-model=static avoids static-pie which is incompatible with Go c-archive relocations.
        # --target is required so RUSTFLAGS (crt-static, relocation-model) don't leak into
        # proc-macro compilation — proc-macros are dylibs and can't use crt-static.
        # The downside is cargo outputs to target/<triple>/$PROFILE/ instead of target/$PROFILE/,
        # so we copy the binary back to the canonical path after building.
        local arch
        arch=$(uname -m)
        local target="${arch}-unknown-linux-gnu"
        export RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=static -C link-arg=-Wl,-z,stack-size=2097152 -C link-arg=-Wl,--allow-multiple-definition"
        echo "🎯 Static glibc binary (crt-static + relocation-model=static)"
        cargo build $build_flag -p boxlite-shim --target "$target"
        cp "$PROJECT_ROOT/target/$target/$PROFILE/boxlite-shim" "$SHIM_BINARY_PATH"
    else
        cargo build $build_flag -p boxlite-shim
    fi
}

# Sign the binary (macOS only, automatic)
sign_binary() {
    if [ "$OS" != "macos" ]; then
        echo "⏭️  Signing skipped (not macOS)"
        return 0
    fi

    # Always sign the build output (cargo produces unsigned binaries)
    echo "📦 Signing boxlite-shim with hypervisor entitlements..."
    "$SCRIPT_BUILD_DIR/sign.sh" "$SHIM_BINARY_PATH"

    # Also sign the destination copy if it exists (cp strips entitlements)
    if [ -n "$DEST_DIR" ] && [ -f "$DEST_DIR/boxlite-shim" ]; then
        "$SCRIPT_BUILD_DIR/sign.sh" "$DEST_DIR/boxlite-shim"
    fi
}

# Copy binary to destination
copy_to_destination() {
    if [ -z "$DEST_DIR" ]; then
        echo "✅ Shim binary built successfully (no destination specified)"
        echo "Binary location: $SHIM_BINARY_PATH"
        return 0
    fi

    # Relative paths are relative to caller's working directory (already resolved)
    # Absolute paths are used as-is
    echo "📦 Copying to destination: $DEST_DIR"
    mkdir -p "$DEST_DIR"
    cp "$SHIM_BINARY_PATH" "$DEST_DIR/"

    echo "✅ Shim binary built and copied to $DEST_DIR"
    echo "Binary info:"
    ls -lh "$DEST_DIR/boxlite-shim"
    file "$DEST_DIR/boxlite-shim"
}

# Main execution
main() {
    build_shim_binary
    copy_to_destination
    sign_binary

    echo ""
    echo "🎉 Done! Shim binary is ready."
}

main "$@"
