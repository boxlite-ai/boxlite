#!/usr/bin/env bash
set -euo pipefail

# Source common utilities
PACKAGE_DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$PACKAGE_DIR_SCRIPT/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Set platform name for help messages
PLATFORM_NAME="Linux"

# Source package-common (which will use PLATFORM_NAME)
source "$PACKAGE_DIR_SCRIPT/package-common.sh"

# Parse arguments
parse_args() {
    parse_package_args "$@"

    ARCH="$(uname -m)"
    PACKAGE_NAME="boxlite-sdk-v${VERSION}-linux-${ARCH}"
    PACKAGE_DIR="$OUTPUT_DIR/$PACKAGE_NAME"
}

# Copy libboxlite.so
copy_libboxlite() {
    print_section "📦 Copying libboxlite.so..."
    cp "$PROJECT_ROOT/target/release/libboxlite.so" "$PACKAGE_DIR/lib/libboxlite.so"
}

# Configure libboxlite SONAME (linuxdeploy will handle RUNPATH)
configure_libboxlite() {
    print_section "🔧 Configuring libboxlite.so..."

    # Set SONAME (CRITICAL: enables ABI versioning)
    patchelf --set-soname "libboxlite.so.0" "$PACKAGE_DIR/lib/libboxlite.so"

    # Create versioned symlinks
    cd "$PACKAGE_DIR/lib"
    ln -sf libboxlite.so libboxlite.so.0
    cd "$PROJECT_ROOT"
}

# Main packaging flow
main() {
    parse_args "$@"

    print_package_info "Linux" "$VERSION" "$ARCH" "$FEATURES"

    create_package_structure "$PACKAGE_DIR"

    build_libboxlite "$FEATURES"
    copy_libboxlite
    configure_libboxlite

    copy_header "$PACKAGE_DIR"

    generate_pkgconfig "$PACKAGE_DIR" "$VERSION"

    create_tarball "$OUTPUT_DIR" "$PACKAGE_NAME"

    print_package_summary "$OUTPUT_DIR" "$PACKAGE_NAME" "so"
}

main "$@"
