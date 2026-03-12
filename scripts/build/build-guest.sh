#!/bin/bash
# Build boxlite-guest binary on macOS or Linux
#
# Prerequisites: Run the appropriate setup script first:
#   - macOS: scripts/setup/setup-macos.sh
#   - Ubuntu/Debian: scripts/setup/setup-ubuntu.sh
#   - musllinux: scripts/setup/setup-musllinux.sh
#
# Usage:
#   ./build-guest.sh [--dest-dir DIR] [--profile PROFILE]
#
# Options:
#   --dest-dir DIR      Directory to copy the guest binary to
#   --profile PROFILE   Build profile: release or debug (default: release)

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/setup/setup-common.sh"

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
                echo "Usage: $0 [--dest-dir DIR] [--profile PROFILE]"
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
print_header "Building boxlite-guest on $OS..."

# Verify prerequisites (fail fast)
check_prerequisites() {
    print_section "Checking prerequisites..."
    require_command "rustc" "Run: scripts/setup/setup-macos.sh (or setup-ubuntu.sh)"
    require_musl
    print_success "All prerequisites satisfied"
    echo ""
}

# Ensure Rust target is added
setup_rust_target() {
    source "$SCRIPT_DIR/util.sh"
    print_step "Checking Rust target $GUEST_TARGET... "
    if rustup target list | grep -q "$GUEST_TARGET (installed)"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Adding...${NC}"
        rustup target add "$GUEST_TARGET"
        print_success "Target added"
    fi
}

# Build the guest binary
build_guest_binary() {
    cd "$PROJECT_ROOT"
    echo "🔨 Building guest binary for $GUEST_TARGET $PROFILE..."
    local build_flag=""
    if [ "$PROFILE" = "release" ]; then
        build_flag="--release"
    fi

    # macOS cross-compilation needs musl-cross linker.
    # The project .cargo/config.toml is platform-agnostic (no linker).
    # Set the linker via env var as fallback if ~/.cargo/config.toml isn't configured.
    if [ "$OS" = "macos" ]; then
        local arch_prefix
        arch_prefix=$(echo "$GUEST_TARGET" | cut -d'-' -f1)
        local env_var_name
        env_var_name="CARGO_TARGET_$(echo "$GUEST_TARGET" | tr '[:lower:]-' '[:upper:]_')_LINKER"
        if [ -z "${!env_var_name:-}" ]; then
            export "$env_var_name=${arch_prefix}-linux-musl-gcc"
        fi
    fi

    cargo build $build_flag --target "$GUEST_TARGET" -p boxlite-guest

    # Verify guest binary is statically linked
    local guest_binary="$PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest"
    local file_output
    file_output=$(file "$guest_binary")
    if echo "$file_output" | grep -q "dynamically linked"; then 
        local musl_arch
        musl_arch=$(echo "$GUEST_TARGET" | cut -d'-' -f1)
        local musl_gcc="${musl_arch}-linux-musl-gcc"

        print_error "boxlite-guest is dynamically linked, but must be statically linked"
        echo ""
        echo "❌ Error: The boxlite-guest binary must be statically linked."
        echo ""
        echo "The guest binary at $guest_binary is dynamically linked, which means"
        echo "it depends on shared libraries that won't be available inside the VM."
        echo ""
        echo "🔧 To fix this issue:"
        echo "  Check your $musl_gcc version:"
        echo "  $ $musl_gcc --version"
        echo "  Verify whether your C compiler is a gnu-gcc wrapper instead of true musl-gcc"
        echo ""
        exit 1
    fi
}

# Copy binary to destination
copy_to_destination() {
    if [ -z "$DEST_DIR" ]; then
        echo "✅ Guest binary built successfully (no destination specified)"
        echo "Binary location: $PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest"
        return 0
    fi

    # Relative paths are relative to caller's working directory (already correct behavior)
    # Absolute paths are used as-is
    echo "📦 Copying to destination: $DEST_DIR"
    mkdir -p "$DEST_DIR"
    cp "$PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest" "$DEST_DIR/"

    echo "✅ Guest binary built and copied to $DEST_DIR"
    echo "Binary info:"
    ls -lh "$DEST_DIR/boxlite-guest"
    file "$DEST_DIR/boxlite-guest"
}

# Main execution
main() {
    check_prerequisites
    setup_rust_target
    build_guest_binary
    copy_to_destination

    echo ""
    print_success "Done! Guest binary is ready for packaging."
}

main "$@"
