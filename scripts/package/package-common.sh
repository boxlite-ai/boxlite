#!/bin/bash
# Common utilities for BoxLite package scripts
#
# This file should be sourced by package scripts, not executed directly.
# Usage: source scripts/package/package-common.sh

# Exit if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "❌ Error: This script should be sourced, not executed directly"
    echo "Usage: source scripts/package/package-common.sh"
    exit 1
fi

# Ensure common.sh is loaded
if [[ -z "$SCRIPT_DIR" ]]; then
    PACKAGE_DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    SCRIPT_DIR="$(cd "$PACKAGE_DIR_SCRIPT/.." && pwd)"
    source "$SCRIPT_DIR/common.sh"
fi

# Default values (can be overridden by scripts)
VERSION=""
OUTPUT_DIR="$PROJECT_ROOT/sdks/c/dist"
ENABLE_GVPROXY=false
ENABLE_LIBSLIRP=false

# Get version from workspace (handles version.workspace = true)
get_version() {
    cargo pkgid -p boxlite-c -q --manifest-path "$PROJECT_ROOT/Cargo.toml" | sed 's/.*boxlite-c@//'
}

# Show usage (platform name passed as argument)
show_package_usage() {
    local platform="$1"
    cat << EOF
Usage: $0 [OPTIONS]

Package BoxLite SDK for $platform with bundled dependencies.

OPTIONS:
    --version VERSION       Package version (default: auto-detect from Cargo.toml)
    --output-dir DIR        Output directory (default: ./sdks/c/dist)
    --enable-gvproxy        Enable gvisor-tap-vsock networking backend
    --enable-libslirp       Enable libslirp networking backend
    -h, --help              Show this help message

EXAMPLES:
    # Package with default settings
    $0

    # Package with gvproxy backend
    $0 --enable-gvproxy

    # Package with both networking backends
    $0 --enable-gvproxy --enable-libslirp

    # Custom version and output directory
    $0 --version 0.2.0 --output-dir /tmp/packages --enable-gvproxy
EOF
}

# Parse common package arguments
parse_package_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --version)
                VERSION="$2"
                shift 2
                ;;
            --output-dir)
                OUTPUT_DIR="$2"
                shift 2
                ;;
            --enable-gvproxy)
                ENABLE_GVPROXY=true
                shift
                ;;
            --enable-libslirp)
                ENABLE_LIBSLIRP=true
                shift
                ;;
            -h|--help)
                show_package_usage "$PLATFORM_NAME"
                exit 0
                ;;
            *)
                echo "❌ Unknown option: $1"
                show_package_usage "$PLATFORM_NAME"
                exit 1
                ;;
        esac
    done

    # Auto-detect version if not provided
    if [ -z "$VERSION" ]; then
        VERSION=$(get_version)
    fi

    # Build feature string
    FEATURES=""
    if [ "$ENABLE_GVPROXY" = true ]; then
        FEATURES="gvproxy-backend"
    fi
    if [ "$ENABLE_LIBSLIRP" = true ]; then
        if [ -n "$FEATURES" ]; then
            FEATURES="$FEATURES,libslirp-backend"
        else
            FEATURES="libslirp-backend"
        fi
    fi
}

# Print package info
print_package_info() {
    local platform="$1"
    local version="$2"
    local arch="$3"
    local features="$4"

    print_info "📦 Packaging BoxLite SDK for $platform..."
    echo "   Version: $version"
    echo "   Arch: $arch"
    echo "   Features: $features"
}

# Create package directory structure
create_package_structure() {
    local package_dir="$1"

    rm -rf "$package_dir"
    mkdir -p "$package_dir"/{lib,include,lib/pkgconfig}
}

# Build libboxlite library
build_libboxlite() {
    local features="$1"

    print_section "🔨 Building libboxlite library..."
    cd "$PROJECT_ROOT/sdks/c"
    if [ -n "$features" ]; then
        cargo build --release --lib --no-default-features --features "$features"
    else
        cargo build --release --lib
    fi
}

# Generate pkg-config file
generate_pkgconfig() {
    local package_dir="$1"
    local version="$2"

    print_section "📝 Generating pkg-config file..."
    cat > "$package_dir/lib/pkgconfig/boxlite.pc" <<EOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: BoxLite
Description: Lightweight VM-based containerization runtime
Version: $version
Libs: -L\${libdir} -lboxlite
Cflags: -I\${includedir}
EOF
}

# Copy C header
copy_header() {
    print_section "📦 Copying C header..."
    local package_dir="$1"
    cp "$PROJECT_ROOT/sdks/c/include/boxlite.h" "$package_dir/include/boxlite.h"
}

# Create tarball
create_tarball() {
    local output_dir="$1"
    local package_name="$2"

    print_section "📦 Creating tarball..."
    cd "$output_dir"
    tar czf "${package_name}.tar.gz" "$package_name"
}

# Print package summary
print_package_summary() {
    local output_dir="$1"
    local package_name="$2"
    local lib_ext="$3"

    print_success "Package created: $output_dir/${package_name}.tar.gz"
    echo ""
    echo "Package contents:"
    echo "  lib/libboxlite.$lib_ext           - Main library"
    echo "  include/boxlite.h              - C header"
    echo "  lib/pkgconfig/boxlite.pc       - pkg-config metadata"
}
