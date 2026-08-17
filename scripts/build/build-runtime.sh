#!/bin/bash
# Populate cargo's OUT_DIR/runtime with all binaries and libraries
#
# This script completes the runtime directory that contains everything
# needed to run BoxLite: shim binary, guest rootfs, and all FFI libraries.
#
# Usage:
#   ./build-runtime.sh [--profile PROFILE]
#
# Options:
#   --profile PROFILE   Build profile: release or debug (default: release)
#
# The runtime directory will contain:
#   - boxlite-shim      VM subprocess runner (statically links libkrun + libgvproxy)
#   - guest-rootfs/     Minimal guest rootfs (Linux directory tree)
#   - libkrunfw.*       libkrunfw library (dlopen'd at runtime)

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Print help message
print_help() {
    cat <<EOF
Usage: build-runtime.sh [OPTIONS]

Populate cargo's OUT_DIR/runtime with all binaries and libraries.

Options:
  --profile PROFILE   Build profile: release or debug (default: release)
  --help, -h          Show this help message

The runtime directory will contain:
  - boxlite-shim      VM subprocess runner (statically links libkrun + libgvproxy)
  - guest-rootfs/     Minimal guest rootfs (Linux directory tree)
  - libkrunfw.*       libkrunfw library (dlopen'd at runtime)

Examples:
  # Build release runtime in default location
  ./build-runtime.sh

  # Build debug runtime
  ./build-runtime.sh --profile debug

  # Full workflow
  bash scripts/build/build-guest.sh
  bash scripts/build/build-shim.sh
  ./build-runtime.sh

EOF
}

# Parse command-line arguments
parse_args() {
    PROFILE="release"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --profile)
                PROFILE="$2"
                shift 2
                ;;
            --help|-h)
                print_help
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Run with --help for usage information"
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
}

# Detect OS
detect_platform() {
    OS=$(detect_os)
    echo "🖥️  Platform: $OS"
}

# Build boxlite-shim binary
build_shim() {
    echo ""
    print_section "Building boxlite-shim binary..."

    local shim_path="$PROJECT_ROOT/target/$PROFILE/boxlite-shim"

    # Skip build if SKIP_SHIM_BUILD=1 and binary exists
    # Used in CI when shim is pre-built on Ubuntu host
    if [ "${SKIP_SHIM_BUILD:-0}" = "1" ]; then
        if [ -f "$shim_path" ] && [ -x "$shim_path" ]; then
            SHIM_BINARY="$shim_path"
            print_success "Using pre-built: $shim_path (SKIP_SHIM_BUILD=1)"
            return 0
        else
            print_error "SKIP_SHIM_BUILD=1 but shim binary not found at $shim_path"
            exit 1
        fi
    fi

    # Always build to ensure freshness (Cargo handles incremental compilation)
    bash "$SCRIPT_BUILD_DIR/build-shim.sh" --profile "$PROFILE"

    if [ -f "$shim_path" ]; then
        SHIM_BINARY="$shim_path"
        print_success "Built: $shim_path"
    else
        print_error "Failed to build boxlite-shim"
        exit 1
    fi
}

# Build the complete minimal guest rootfs.
build_guest_rootfs() {
    echo ""
    print_section "Building minimal guest rootfs..."

    source "$SCRIPT_DIR/util.sh"
    local guest_rootfs="$PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/guest-rootfs"

    # Used in CI when the complete rootfs was built on an Ubuntu host.
    if [ "${SKIP_GUEST_ROOTFS_BUILD:-0}" = "1" ]; then
        if [ -d "$guest_rootfs/rootfs" ] && [ -x "$guest_rootfs/rootfs/boxlite/bin/boxlite-guest" ]; then
            GUEST_ROOTFS_DIR="$guest_rootfs"
            print_success "Using pre-built: $guest_rootfs (SKIP_GUEST_ROOTFS_BUILD=1)"
            return 0
        else
            print_error "SKIP_GUEST_ROOTFS_BUILD=1 but guest rootfs not found at $guest_rootfs"
            exit 1
        fi
    fi

    bash "$SCRIPT_BUILD_DIR/build-guest.sh" --target "$GUEST_TARGET" --profile "$PROFILE"
    bash "$SCRIPT_BUILD_DIR/build-guest-rootfs.sh" --target "$GUEST_TARGET" --profile "$PROFILE"

    if [ -d "$guest_rootfs/rootfs" ]; then
        GUEST_ROOTFS_DIR="$guest_rootfs"
        print_success "Built: $guest_rootfs"
    else
        print_error "Failed to build guest rootfs"
        exit 1
    fi
}

# Find and collect FFI libraries
collect_libraries() {
    echo ""
    print_section "Collecting FFI libraries..."

    cd "$PROJECT_ROOT"

    # Build boxlite crate to generate OUT_DIR with bundled libraries
    local build_flag=""
    if [ "$PROFILE" = "release" ]; then
        build_flag="--release"
    fi

    # Build boxlite crate and capture the exact OUT_DIR from cargo's JSON output
    # This is deterministic - no guessing based on directory names or timestamps
    local runtime_src=""
    runtime_src=$(cargo build $build_flag --lib -p boxlite --message-format=json 2>/dev/null | \
        grep -o '"out_dir":"[^"]*"' | \
        tail -1 | \
        cut -d'"' -f4)

    if [ -n "$runtime_src" ]; then
        runtime_src="$runtime_src/runtime"
    fi

    # Fallback: if JSON parsing failed, find by modification time (newest first)
    if [ -z "$runtime_src" ] || [ ! -d "$runtime_src" ]; then
        local out_dir
        out_dir=$(cargo metadata --format-version 1 2>/dev/null | \
            grep -o '"target_directory":"[^"]*"' | \
            cut -d'"' -f4)

        if [ -z "$out_dir" ]; then
            out_dir="$PROJECT_ROOT/target"
        fi

        # Sort by modification time (newest first) to get the most recent build
        runtime_src=$(find "$out_dir/$PROFILE/build/boxlite-"*/out/runtime -type d -print0 2>/dev/null | \
            xargs -0 ls -dt 2>/dev/null | head -1)
    fi

    if [ -z "$runtime_src" ] || [ ! -d "$runtime_src" ]; then
        print_error "Could not find runtime libraries directory"
        echo "Expected location: $out_dir/$PROFILE/build/boxlite-*/out/runtime"
        exit 1
    fi

    RUNTIME_LIBS_DIR="$runtime_src"
    print_success "Found libraries at: $RUNTIME_LIBS_DIR"
}

# Add the binaries alongside the libraries cargo already staged
assemble_runtime() {
    echo ""
    print_section "Assembling runtime directory..."

    # The libraries are already in place — only the binaries are missing
    mkdir -p "$RUNTIME_LIBS_DIR"

    print_step "Copying boxlite-shim... "
    cp "$SHIM_BINARY" "$RUNTIME_LIBS_DIR/"
    echo "✓"

    print_step "Copying guest-rootfs... "
    rm -f -- "$RUNTIME_LIBS_DIR/boxlite-guest"
    rm -rf -- "$RUNTIME_LIBS_DIR/guest-rootfs"
    cp -R "$GUEST_ROOTFS_DIR" "$RUNTIME_LIBS_DIR/guest-rootfs"
    echo "✓"

    # Sign shim on macOS (always, to ensure proper entitlements)
    if [ "$OS" = "macos" ] && [ -f "$RUNTIME_LIBS_DIR/boxlite-shim" ]; then
        echo ""
        print_section "Signing boxlite-shim... "
        "$SCRIPT_BUILD_DIR/sign.sh" "$RUNTIME_LIBS_DIR/boxlite-shim"
        echo "✓"
    fi

    print_success "Runtime directory assembled"
}

# Display runtime directory contents
show_summary() {
    echo ""
    print_section "Runtime Directory Summary"
    echo "Location: $RUNTIME_LIBS_DIR"
    echo ""
    echo "Contents:"
    ls -lh "$RUNTIME_LIBS_DIR" | tail -n +2 | while read -r line; do
        echo "  $line"
    done
    echo ""

    # Show file types
    echo "File types:"
    for file in "$RUNTIME_LIBS_DIR"/*; do
        if [ -f "$file" ]; then
            local filename
            local filetype
            filename=$(basename "$file")
            filetype=$(file "$file" | cut -d: -f2-)
            echo "  $filename:$filetype"
        fi
    done
}

# Main execution
main() {
    parse_args "$@"

    print_header "🔨 BoxLite Runtime Preparation"
    echo "Profile: $PROFILE"
    echo ""

    detect_platform
    build_shim
    build_guest_rootfs
    collect_libraries
    echo "Destination: $RUNTIME_LIBS_DIR"

    assemble_runtime
    show_summary

    echo ""
    print_success "✅ Runtime preparation complete!"
    echo ""
}

main "$@"
