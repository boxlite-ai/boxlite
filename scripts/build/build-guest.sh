#!/bin/bash
# Build boxlite-guest binary on macOS or Linux
#
# Prerequisites: Run the appropriate setup script first:
#   - macOS: scripts/setup/setup-macos.sh
#   - Ubuntu/Debian: scripts/setup/setup-ubuntu.sh
#   - musllinux: scripts/setup/setup-musllinux.sh
#
# Usage:
#   ./build-guest.sh [--profile PROFILE]
#
# Options:
#   --profile PROFILE   Build profile: release or debug (default: release)

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/setup/setup-common.sh"
# shellcheck source=../util.sh
source "$SCRIPT_DIR/util.sh"

# Parse command-line arguments
parse_args() {
    PROFILE="${PROFILE:-release}"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --profile)
                PROFILE="$2"
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--profile PROFILE]"
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

parse_args "$@"

# Detect OS
OS=$(detect_os)

# Verify prerequisites (fail fast)
check_prerequisites() {
    print_section "Checking prerequisites..."
    require_command "rustc" "Run: scripts/setup/setup-macos.sh (or setup-ubuntu.sh)"
    init_musl_toolchain "$GUEST_TARGET"
    print_success "All prerequisites satisfied"
    echo ""
}

# Ensure Rust target is added
setup_rust_target() {
    print_step "Checking Rust target $GUEST_TARGET... "
    if rustup target list | grep -q "$GUEST_TARGET (installed)"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Adding...${NC}"
        rustup target add "$GUEST_TARGET"
        print_success "Target added"
    fi
}

_build_guest_binary_with_libseccomp() {
    cd "$PROJECT_ROOT"
    echo "🔨 Building guest binary for $GUEST_TARGET $PROFILE..."
    local build_flag=""
    if [ "$PROFILE" = "release" ]; then
        build_flag="--release"
    fi

    cargo build $build_flag --target "$GUEST_TARGET" -p boxlite-guest
}

# Build the guest binary while Cargo and libseccomp-sys consume one immutable
# cache generation. The physical path also makes Cargo rerun libseccomp-sys when
# publication selects a different generation.
build_guest_binary() {
    # shellcheck source=./build-libseccomp.sh
    source "$SCRIPT_BUILD_DIR/build-libseccomp.sh"
    with_libseccomp_for_target \
        "$GUEST_TARGET" _build_guest_binary_with_libseccomp
}

build_guest_tools() {
    # shellcheck source=./build-e2fsprogs-guest.sh
    source "$SCRIPT_BUILD_DIR/build-e2fsprogs-guest.sh"
    ensure_guest_e2fsprogs_for_target "$GUEST_TARGET" "$PROFILE"
}

verify_guest_artifacts() {
    # shellcheck source=./verify-guest-elf.sh
    source "$SCRIPT_BUILD_DIR/verify-guest-elf.sh"

    local output_dir="$PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE"
    local guest_binary="$output_dir/boxlite-guest"
    local tools_dir="$output_dir/guest-tools"

    verify_guest_elf "$GUEST_TARGET" "$guest_binary"
    verify_guest_elf "$GUEST_TARGET" "$tools_dir/mke2fs"
    verify_guest_elf "$GUEST_TARGET" "$tools_dir/resize2fs"
}

# Main execution
main() {
    print_header "Building boxlite-guest and guest tools on $OS..."
    check_prerequisites
    setup_rust_target
    build_guest_tools
    build_guest_binary
    verify_guest_artifacts

    echo "✅ Guest artifacts built successfully"
    echo "Binary location: $PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest"
    echo "Tools location:  $PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/guest-tools"

    echo ""
    print_success "Done! Guest binary is ready for packaging."
}

main "$@"
