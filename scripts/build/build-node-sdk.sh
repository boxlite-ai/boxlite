#!/bin/bash
# Build Node.js SDK with napi-rs
#
# This script builds the Node.js SDK including native bindings, TypeScript
# wrappers, and platform-specific packages ready for npm publishing.
#
# Usage:
#   ./build-node-sdk.sh [--profile PROFILE]
#
# Options:
#   --profile PROFILE   Build profile: release or debug (default: release)
#   --help, -h          Show this help message
#
# The output will contain:
#   - Main package (@boxlite-ai/boxlite)
#   - Platform package (@boxlite-ai/boxlite-{platform})
#
# Prerequisites:
#   - Node.js >= 18
#   - npm
#   - Rust toolchain
#   - Runtime must be built first (make runtime)

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# SDK directories
NODE_SDK_DIR="$PROJECT_ROOT/sdks/node"
RUNTIME_DIR="$PROJECT_ROOT/target/boxlite-runtime"
OUTPUT_DIR="$NODE_SDK_DIR/packages"

# Print help message
print_help() {
    cat <<EOF
Usage: build-node-sdk.sh [OPTIONS]

Build Node.js SDK with napi-rs native bindings.

Options:
  --profile PROFILE   Build profile: release or debug (default: release)
  --help, -h          Show this help message

The output will contain:
  - Main package (@boxlite-ai/boxlite) with TypeScript wrappers
  - Platform package (@boxlite-ai/boxlite-{platform}) with native binary and runtime

Examples:
  # Build release SDK
  ./build-node-sdk.sh

  # Build debug SDK
  ./build-node-sdk.sh --profile debug

Prerequisites:
  # Build runtime first
  make runtime

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
        print_error "Invalid profile: $PROFILE"
        echo "Run with --profile release or --profile debug"
        exit 1
    fi
}

# Detect platform and set variables
detect_platform() {
    OS=$(detect_os)
    ARCH=$(uname -m)

    # Determine platform string for napi-rs
    if [ "$OS" = "macos" ]; then
        if [ "$ARCH" = "arm64" ]; then
            PLATFORM="darwin-arm64"
        else
            PLATFORM="darwin-x64"
        fi
        NODE_FILE="index.$PLATFORM.node"
    else
        if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
            PLATFORM="linux-arm64-gnu"
        else
            PLATFORM="linux-x64-gnu"
        fi
        NODE_FILE="index.$PLATFORM.node"
    fi

    echo "🖥️  Platform: $OS ($ARCH)"
    echo "📦 Target: $PLATFORM"
}

# Install npm dependencies
install_dependencies() {
    print_section "Installing npm dependencies..."

    cd "$NODE_SDK_DIR"
    npm install --silent

    print_success "Dependencies installed"
}

# Build native addon with napi-rs
build_native_addon() {
    print_section "Building native addon with napi-rs..."

    cd "$NODE_SDK_DIR"

    # Use --use-napi-cross on Linux for glibc 2.17 compatibility
    local napi_flags="--platform"
    if [ "$OS" = "linux" ]; then
        napi_flags="$napi_flags --use-napi-cross"
        print_info "Using napi-cross for glibc 2.17 compatibility"
    fi

    if [ "$PROFILE" = "release" ]; then
        npx napi build $napi_flags --release
    else
        npx napi build $napi_flags
    fi

    # Verify native module was created
    if [ ! -f "$NODE_SDK_DIR/$NODE_FILE" ]; then
        print_error "Native module not found: $NODE_FILE"
        exit 1
    fi

    print_success "Native addon built: $NODE_FILE"
}

# Build TypeScript
build_typescript() {
    print_section "Building TypeScript..."

    cd "$NODE_SDK_DIR"
    npm run build

    print_success "TypeScript compiled"
}

# Add rpath to native module
setup_rpath() {
    print_section "Setting up rpath..."

    local native_module="$NODE_SDK_DIR/$NODE_FILE"

    if [ "$OS" = "macos" ]; then
        install_name_tool -add_rpath @loader_path/runtime "$native_module" 2>/dev/null || true
    else
        patchelf --set-rpath '$ORIGIN/runtime' "$native_module" 2>/dev/null || true
    fi

    print_success "Rpath configured"
}

# Create platform-specific package
create_platform_package() {
    print_section "Creating platform package..."

    local pkg_dir="$NODE_SDK_DIR/npm/$PLATFORM"

    # Determine OS and CPU for package.json
    local pkg_os pkg_cpu
    if [[ "$PLATFORM" == darwin-* ]]; then
        pkg_os="darwin"
    else
        pkg_os="linux"
    fi

    if [[ "$PLATFORM" == *-arm64* ]]; then
        pkg_cpu="arm64"
    else
        pkg_cpu="x64"
    fi

    # Create package directory
    mkdir -p "$pkg_dir"

    # Copy native module
    print_step "Copying native module... "
    cp "$NODE_SDK_DIR/$NODE_FILE" "$pkg_dir/"
    echo "✓"

    # Copy runtime
    print_step "Copying runtime... "
    rm -rf "$pkg_dir/runtime"
    cp -a "$RUNTIME_DIR" "$pkg_dir/runtime"
    echo "✓"

    # Generate package.json
    print_step "Generating package.json... "
    cat > "$pkg_dir/package.json" << EOF
{
  "name": "@boxlite-ai/boxlite-$PLATFORM",
  "version": "0.1.0",
  "os": ["$pkg_os"],
  "cpu": ["$pkg_cpu"],
  "main": "$NODE_FILE",
  "files": [
    "$NODE_FILE",
    "runtime"
  ],
  "description": "BoxLite native bindings for $PLATFORM",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/anthropics/boxlite.git",
    "directory": "sdks/node"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF
    echo "✓"

    PLATFORM_PKG_DIR="$pkg_dir"
    print_success "Platform package created: @boxlite-ai/boxlite-$PLATFORM"
}

# Create tarballs
create_tarballs() {
    print_section "Creating tarballs..."

    rm -rf "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"

    # Pack main package
    print_step "Packing main package... "
    cd "$NODE_SDK_DIR"
    npm pack --pack-destination "$OUTPUT_DIR" > /dev/null
    echo "✓"

    # Pack platform package
    print_step "Packing platform package... "
    cd "$PLATFORM_PKG_DIR"
    npm pack --pack-destination "$OUTPUT_DIR" > /dev/null
    echo "✓"

    print_success "Tarballs created"
}

# Show build summary
show_summary() {
    echo ""
    print_section "Build Summary"
    echo "Output directory: $OUTPUT_DIR"
    echo ""
    echo "Packages:"
    ls -lh "$OUTPUT_DIR"/*.tgz | while read -r line; do
        echo "  $line"
    done
    echo ""
    echo "Install locally:"
    echo "  npm install $OUTPUT_DIR/boxlite-ai-boxlite-$PLATFORM-0.1.0.tgz"
    echo "  npm install $OUTPUT_DIR/boxlite-ai-boxlite-0.1.0.tgz"
    echo ""
    echo "Publish to npm:"
    echo "  cd $PLATFORM_PKG_DIR && npm publish --access public"
    echo "  cd $NODE_SDK_DIR && npm publish --access public"
}

# Main execution
main() {
    parse_args "$@"

    print_header "📦 Node.js SDK Build"
    echo "Profile: $PROFILE"
    echo ""

    detect_platform
    install_dependencies
    build_native_addon
    build_typescript
    setup_rpath
    create_platform_package
    create_tarballs
    show_summary

    echo ""
    print_success "✅ Node.js SDK built successfully!"
    echo ""
}

main "$@"
