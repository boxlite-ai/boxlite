#!/usr/bin/env bash
set -euo pipefail

# Source common utilities
PACKAGE_DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$PACKAGE_DIR_SCRIPT/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Set platform name for help messages
PLATFORM_NAME="macOS"

# Source package-common (which will use PLATFORM_NAME)
source "$PACKAGE_DIR_SCRIPT/package-common.sh"

# Parse arguments
parse_args() {
    parse_package_args "$@"

    ARCH="$(uname -m)"
    PACKAGE_NAME="boxlite-sdk-v${VERSION}-macos-${ARCH}"
    PACKAGE_DIR="$OUTPUT_DIR/$PACKAGE_NAME"
}

# Copy libboxlite.dylib
copy_libboxlite() {
    print_section "📦 Copying libboxlite.dylib..."
    cp "$PROJECT_ROOT/target/release/libboxlite.dylib" "$PACKAGE_DIR/lib/libboxlite.dylib"
}

# Configure libboxlite install name (dylibbundler will handle dependencies)
configure_libboxlite() {
    print_section "🔧 Configuring libboxlite.dylib..."

    # Set install name (CRITICAL: allows relocatable linking)
    install_name_tool -id "@rpath/libboxlite.dylib" \
        "$PACKAGE_DIR/lib/libboxlite.dylib"

    # Add RPATH to find bundled deps
    install_name_tool -add_rpath "@loader_path/../boxlite-runtime" \
        "$PACKAGE_DIR/lib/libboxlite.dylib"
}

# Bundle dependencies using dylibbundler
bundle_dependencies() {
    print_section "📦 Bundling dependencies with dylibbundler..."

    # Bundle dependencies for libboxlite.dylib
    echo "  Bundling dependencies for libboxlite.dylib..."
    dylibbundler -cd -of -b \
        -x "$PACKAGE_DIR/lib/libboxlite.dylib" \
        -d "$PACKAGE_DIR/boxlite-runtime/" \
        -p "@loader_path/../boxlite-runtime"

    # Bundle dependencies for boxlite-shim
    echo "  Bundling dependencies for boxlite-shim..."
    dylibbundler -cd -of -b \
        -x "$PACKAGE_DIR/boxlite-runtime/boxlite-shim" \
        -d "$PACKAGE_DIR/boxlite-runtime/" \
        -p "@loader_path"
}

# Main packaging flow
main() {
    parse_args "$@"

    print_package_info "macOS" "$VERSION" "$ARCH" "$FEATURES"

    create_package_structure "$PACKAGE_DIR"

    build_libboxlite "$FEATURES"
    copy_libboxlite
    configure_libboxlite

    copy_header "$PACKAGE_DIR"

    generate_pkgconfig "$PACKAGE_DIR" "$VERSION"

    create_tarball "$OUTPUT_DIR" "$PACKAGE_NAME"

    print_package_summary "$OUTPUT_DIR" "$PACKAGE_NAME" "dylib"
}

main "$@"
