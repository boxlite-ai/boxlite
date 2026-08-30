#!/bin/bash
# Build boxlite-guest binary on macOS or Linux
#
# Prerequisites: Run the appropriate setup script first:
#   - macOS: scripts/setup/setup-macos.sh
#   - Ubuntu/Debian: scripts/setup/setup-ubuntu.sh
#   - musllinux: scripts/setup/setup-musllinux.sh
#
# Usage:
#   ./build-guest.sh [--target TARGET] [--profile PROFILE]
#
# Options:
#   --target TARGET     Guest musl target (default: native architecture)
#   --profile PROFILE   Build profile: release or debug (default: release)

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/setup/setup-common.sh"

# Parse command-line arguments
parse_args() {
    GUEST_TARGET="${GUEST_TARGET:-}"
    PROFILE="release"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --target)
                [ "$#" -ge 2 ] || { echo "--target requires a value"; exit 1; }
                GUEST_TARGET="$2"
                shift 2
                ;;
            --profile)
                [ "$#" -ge 2 ] || { echo "--profile requires a value"; exit 1; }
                PROFILE="$2"
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--target TARGET] [--profile PROFILE]"
                exit 1
                ;;
        esac
    done

    if [ -z "$GUEST_TARGET" ]; then
        GUEST_TARGET=$(bash "$SCRIPT_DIR/util.sh" --target)
    fi
    case "$GUEST_TARGET" in
        x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;;
        *)
            echo "Invalid guest target: $GUEST_TARGET"
            exit 1
            ;;
    esac

    if [ "$PROFILE" != "release" ] && [ "$PROFILE" != "debug" ]; then
        echo "Invalid profile: $PROFILE"
        echo "Run with --profile release or --profile debug"
        exit 1
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
    print_step "Checking Rust target $GUEST_TARGET... "
    if rustup target list | grep -q "$GUEST_TARGET (installed)"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Adding...${NC}"
        rustup target add "$GUEST_TARGET"
        print_success "Target added"
    fi
}

find_readelf() {
    local candidate
    for candidate in "${READELF:-}" "${GUEST_TARGET%%-*}-linux-musl-readelf" llvm-readelf \
        /opt/homebrew/opt/llvm/bin/llvm-readelf /usr/local/opt/llvm/bin/llvm-readelf readelf; do
        [ -n "$candidate" ] || continue
        command -v "$candidate" >/dev/null 2>&1 || continue
        echo "$candidate"
        return 0
    done
    print_error "readelf or llvm-readelf is required to verify boxlite-guest" >&2
    return 1
}

verify_guest_binary() {
    local path="$1" machine header programs dynamic readelf_tool
    if [ ! -f "$path" ] || [ -L "$path" ] || [ ! -s "$path" ] || [ ! -x "$path" ]; then
        print_error "invalid boxlite-guest output: $path"
        return 1
    fi

    case "$GUEST_TARGET" in
        x86_64-unknown-linux-musl) machine='Advanced Micro Devices X86-64|AMD x86-64|X86-64|x86-64' ;;
        aarch64-unknown-linux-musl) machine='AArch64' ;;
    esac

    readelf_tool=$(find_readelf)
    header=$(LC_ALL=C "$readelf_tool" -hW "$path") || {
        print_error "failed to read ELF header: $path"; return 1;
    }
    programs=$(LC_ALL=C "$readelf_tool" -lW "$path") || {
        print_error "failed to read program headers: $path"; return 1;
    }
    dynamic=$(LC_ALL=C "$readelf_tool" -dW "$path") || {
        print_error "failed to read dynamic section: $path"; return 1;
    }

    printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF64([[:space:]]|$)' || {
        print_error "boxlite-guest must be ELF64: $path"; return 1;
    }
    printf '%s\n' "$header" | grep -Eiq 'Data:[[:space:]]+2.s complement,[[:space:]]+little([ -])endian' || {
        print_error "boxlite-guest must be little-endian: $path"; return 1;
    }
    printf '%s\n' "$header" | grep -Eq 'Type:[[:space:]]+(EXEC|DYN)([[:space:]]|$)' || {
        print_error "boxlite-guest must be ET_EXEC or static PIE: $path"; return 1;
    }
    printf '%s\n' "$header" | grep -Eq "Machine:[[:space:]]+($machine)([[:space:]]|$)" || {
        print_error "boxlite-guest architecture does not match $GUEST_TARGET: $path"; return 1;
    }
    printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])LOAD([[:space:]]|$)' || {
        print_error "boxlite-guest has no loadable segment: $path"; return 1;
    }
    if printf '%s\n' "$programs" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)'; then
        print_error "boxlite-guest has a PT_INTERP segment: $path"
        return 1
    fi
    if printf '%s\n' "$dynamic" | grep -Eq '(\(NEEDED\)|(^|[[:space:]])NEEDED([[:space:]]|$))'; then
        print_error "boxlite-guest has a DT_NEEDED entry: $path"
        return 1
    fi
}

normalize_guest_binary_mode() {
    local path="$1"
    if [ ! -f "$path" ] || [ -L "$path" ] || [ ! -s "$path" ]; then
        print_error "invalid boxlite-guest output: $path"
        return 1
    fi

    chmod 0755 "$path"
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

    # libseccomp is enabled in src/guest/Cargo.toml ("libseccomp" feature on
    # libcontainer). The Rust libseccomp-sys crate needs libseccomp.a built for
    # the *target* triple. Build/cache it and export the env vars libseccomp-sys
    # reads in its build.rs.
    # shellcheck source=./build-libseccomp.sh
    source "$SCRIPT_BUILD_DIR/build-libseccomp.sh"
    ensure_libseccomp_for_target "$GUEST_TARGET"

    cargo build $build_flag --target "$GUEST_TARGET" -p boxlite-guest

    local guest_binary="$PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest"
    normalize_guest_binary_mode "$guest_binary"
    verify_guest_binary "$guest_binary"
}

# Main execution
main() {
    check_prerequisites
    setup_rust_target
    build_guest_binary

    echo "✅ Guest binary built successfully"
    echo "Binary location: $PROJECT_ROOT/target/$GUEST_TARGET/$PROFILE/boxlite-guest"

    echo ""
    print_success "Done! Guest binary is ready."
}

main "$@"
