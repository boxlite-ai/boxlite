#!/bin/bash
# Universal script to build boxlite-shim binary on macOS or Linux
#
# Usage:
#   ./build-shim.sh [--dest-dir DIR]
#
# Options:
#   --dest-dir DIR    Directory to copy the shim binary to
#   --profile PROFILE   Build profile: release or debug
#
# BUILD_PROFILE also selects the profile; the default is release.
#
# Note: On macOS, the binary is automatically signed with hypervisor entitlements

set -e

# Load canonical build-context utilities
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Capture original working directory before any cd commands
ORIG_DIR="$(pwd)"

# Parse command-line arguments
parse_args() {
    DEST_DIR_ARG=""
    PROFILE="${BUILD_PROFILE:-release}"

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

    set_cargo_profile "$PROFILE" || exit 1
    DEST_DIR=$(resolve_path_from "$ORIG_DIR" "$DEST_DIR_ARG")
}

parse_args "$@"

# Detect OS
OS=$(detect_os)
print_header "🚀 Building boxlite-shim on $OS..."

CARGO_TARGET_ROOT=$(cargo_target_dir)
SHIM_BINARY_PATH="$CARGO_TARGET_ROOT/$PROFILE/boxlite-shim"

# Build the shim binary
build_shim_binary() {
    cd "$PROJECT_ROOT"
    echo "🔨 Building shim binary $PROFILE..."
    local cargo_args

    if [ "$OS" = "linux" ]; then
        # Build from src/shim so Cargo applies the shim-only Linux rustflags in
        # src/shim/.cargo/config.toml. The explicit target keeps those flags off
        # host-built proc macros, which are dynamic libraries and cannot use
        # crt-static. Cargo then writes the shim under target/<triple>/<profile>,
        # so copy it back to target/<profile> for runtime assembly and embedding.
        local target
        target=$(shim_target_triple)

        echo "🎯 Static PIE target: $target (crt-static)"
        cargo_args=(build -p boxlite-shim --target "$target")
        if [ -n "$CARGO_PROFILE_ARG" ]; then
            cargo_args+=("$CARGO_PROFILE_ARG")
        fi
        (cd "$PROJECT_ROOT/src/shim" && CARGO_TARGET_DIR="$CARGO_TARGET_ROOT" cargo "${cargo_args[@]}")
        mkdir -p "$(dirname "$SHIM_BINARY_PATH")"
        cp "$CARGO_TARGET_ROOT/$target/$PROFILE/boxlite-shim" "$SHIM_BINARY_PATH"
    else
        # libkrun always builds a Linux init binary, even when its host library
        # targets macOS. Configure the cross compiler before Cargo starts building
        # the dependency graph.
        configure_libkrun_cc_linux || return 1
        cargo_args=(build -p boxlite-shim)
        if [ -n "$CARGO_PROFILE_ARG" ]; then
            cargo_args+=("$CARGO_PROFILE_ARG")
        fi
        cargo "${cargo_args[@]}"
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
