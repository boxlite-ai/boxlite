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
ensure_cargo

# SDK directories
NODE_SDK_DIR="$PROJECT_ROOT/sdks/node"
RUNTIME_DIR="$PROJECT_ROOT/target/boxlite-runtime"
OUTPUT_DIR="$NODE_SDK_DIR/packages"

# Get main package version from package.json
get_main_version() {
    node -p "require('$NODE_SDK_DIR/package.json').version"
}

# Generate package.json from template
# Args: template output version [platform os cpu node_file libc_line]
generate_package_json() {
    local template="$1"
    local output="$2"
    local version="$3"

    sed -e "s/{{VERSION}}/$version/g" \
        -e "s/{{PLATFORM}}/${4:-}/g" \
        -e "s/{{OS}}/${5:-}/g" \
        -e "s/{{CPU}}/${6:-}/g" \
        -e "s/{{NODE_FILE}}/${7:-}/g" \
        -e "s|{{LIBC_LINE}}|${8:-}|g" \
        "$template" > "$output"
}

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

# Build platform-specific package with native addon
build_platform_package() {
    print_section "Building platform package..."

    local pkg_dir="$NODE_SDK_DIR/npm/$PLATFORM"
    PLATFORM_PKG_DIR="$pkg_dir"
    local pkg_version
    pkg_version=$(get_main_version)

    # Create package directory
    mkdir -p "$pkg_dir"

    # Build native addon with napi-rs
    # Note: Must run in NODE_SDK_DIR where Cargo.toml and napi.config.json are located
    print_step "Building native addon... "
    cd "$NODE_SDK_DIR"

    # Note: We don't use --use-napi-cross on Linux because:
    # 1. libkrun is built natively for the host glibc (e.g., 2.35 on ubuntu-latest)
    # 2. napi-cross targets glibc 2.17, which is ABI-incompatible with host libkrun
    # 3. The resulting binary requires glibc 2.28+ (manylinux container)
    local napi_flags="--platform"
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
    echo "✓"

    # Move native module to package directory
    print_step "Moving native module... "
    mv "$NODE_SDK_DIR/$NODE_FILE" "$pkg_dir/"
    echo "✓"

    # Fix dylib paths for distribution
    print_step "Fixing dylib paths... "
    local native_module="$pkg_dir/$NODE_FILE"
    if [ "$OS" = "macos" ]; then
        # Fix LC_ID_DYLIB: change absolute build path to relative @loader_path
        install_name_tool -id "@loader_path/$NODE_FILE" "$native_module"
        # Add rpath for runtime dependencies (libkrun, libgvproxy)
        install_name_tool -add_rpath @loader_path/runtime "$native_module" 2>/dev/null || true
    else
        # Linux: set rpath for runtime dependencies (soname is already correct)
        patchelf --set-rpath '$ORIGIN/runtime' "$native_module" 2>/dev/null || true
    fi
    echo "✓"

    # Copy runtime
    print_step "Copying runtime... "
    rm -rf "$pkg_dir/runtime"
    cp -a "$RUNTIME_DIR" "$pkg_dir/runtime"
    echo "✓"

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

    # Determine libc for Linux (glibc vs musl)
    local pkg_libc=""
    if [[ "$PLATFORM" == linux-*-gnu ]]; then
        pkg_libc="glibc"
    elif [[ "$PLATFORM" == linux-*-musl ]]; then
        pkg_libc="musl"
    fi

    # Generate platform package.json from template
    print_step "Generating platform package.json... "
    local libc_line=""
    if [ -n "$pkg_libc" ]; then
        libc_line='"libc": ["'"$pkg_libc"'"],'
    fi
    generate_package_json "$NODE_SDK_DIR/platform-package.template.json" "$pkg_dir/package.json" \
        "$pkg_version" "$PLATFORM" "$pkg_os" "$pkg_cpu" "$NODE_FILE" "$libc_line"
    echo "✓"

    print_success "Platform package built: @boxlite-ai/boxlite-$PLATFORM v$pkg_version"
}

# Build TypeScript
build_typescript() {
    print_section "Building TypeScript..."

    cd "$NODE_SDK_DIR"
    # runs tsc (TypeScript compiler) based on tsconfig.json
    npm run build

    print_success "TypeScript compiled"
}

# Update optionalDependencies versions to match main package version
# This ensures npm can install the correct platform-specific packages
update_optional_dependencies() {
    print_section "Updating optionalDependencies versions..."

    local pkg_version
    pkg_version=$(get_main_version)
    local pkg_json="$NODE_SDK_DIR/package.json"

    # Use node to update JSON (preserves formatting better than sed/jq)
    node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$pkg_json', 'utf8'));
        if (pkg.optionalDependencies) {
            for (const dep of Object.keys(pkg.optionalDependencies)) {
                pkg.optionalDependencies[dep] = '$pkg_version';
            }
        }
        fs.writeFileSync('$pkg_json', JSON.stringify(pkg, null, 2) + '\n');
    "

    print_success "optionalDependencies updated to v$pkg_version"
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
    local pkg_version
    pkg_version=$(get_main_version)

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
    echo "  npm install $OUTPUT_DIR/boxlite-ai-boxlite-$PLATFORM-$pkg_version.tgz"
    echo "  npm install $OUTPUT_DIR/boxlite-ai-boxlite-$pkg_version.tgz"
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
    build_platform_package
    build_typescript
    update_optional_dependencies
    create_tarballs
    show_summary

    echo ""
    print_success "✅ Node.js SDK built successfully!"
    echo ""
}

main "$@"
