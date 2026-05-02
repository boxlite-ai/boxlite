#!/bin/bash
# Setup script for BoxLite development on macOS
#
# This script installs all required dependencies for building BoxLite on macOS.
# Run this once when setting up a new development environment.

set -e

# Source common utilities
SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SETUP_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SETUP_DIR/setup-common.sh"

# Check if running on macOS
check_platform() {
    if [[ "$(uname)" != "Darwin" ]]; then
        print_error "This script is for macOS only"
        echo "   For Ubuntu/Debian, use: bash scripts/setup/setup-ubuntu.sh"
        echo "   For manylinux/RHEL/CentOS, use: bash scripts/setup/setup-manylinux.sh"
        exit 1
    fi
}

# Check if a Homebrew package is installed
brew_installed() {
    brew list "$1" &>/dev/null
}

# Check and install Homebrew
setup_homebrew() {
    print_step "Checking for Homebrew... "
    if command_exists brew; then
        print_success "Found"
    else
        print_error "Not found"
        echo ""
        print_section "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # Add Homebrew to PATH for Apple Silicon Macs
        if [[ -f "/opt/homebrew/bin/brew" ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi

        print_success "Homebrew installed"
    fi
}

# Update Homebrew (non-fatal if it fails)
update_homebrew() {
    print_section "🔄 Updating Homebrew..."
    if ! brew update; then
        print_warning "Homebrew update failed (network issue?), continuing anyway..."
    fi
    echo ""
}

# Setup Rust
setup_rust() {
    if ! check_rust; then
        install_rust
        export RUST_JUST_INSTALLED=true
    fi
    echo ""
}

# Setup Rust target
setup_rust_target() {
    detect_guest_target
    check_rust_target "$GUEST_TARGET"
    echo ""
}

# Install musl-cross
install_musl_cross() {
    print_step "Checking for musl-cross... "
    if brew_installed "musl-cross"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install FiloSottile/musl-cross/musl-cross
        print_success "musl-cross installed"
    fi
    echo ""
}

# Configure musl cross-linker in user's cargo config
#
# The project .cargo/config.toml only has rustflags (platform-agnostic).
# macOS needs the musl-cross linker for cross-compiling to Linux musl targets.
# On Linux, Rust's default self-contained musl linking works without a custom linker.
setup_musl_linker() {
    local cargo_config="${CARGO_HOME:-$HOME/.cargo}/config.toml"

    print_step "Configuring musl cross-linker in cargo config... "
    if grep -q "x86_64-linux-musl-gcc\|aarch64-linux-musl-gcc" "$cargo_config" 2>/dev/null; then
        print_success "Already configured"
    else
        mkdir -p "$(dirname "$cargo_config")"
        cat >> "$cargo_config" << 'EOF'

# BoxLite: musl cross-linker for building guest binary on macOS
[target.x86_64-unknown-linux-musl]
linker = "x86_64-linux-musl-gcc"

[target.aarch64-unknown-linux-musl]
linker = "aarch64-linux-musl-gcc"
EOF
        print_success "Configured"
    fi
    echo ""
}

# Install dtc (device tree compiler) - required for building libkrun
install_dtc() {
    print_step "Checking for dtc... "
    if brew_installed "dtc"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install dtc
        print_success "dtc installed"
    fi
    echo ""
}

# Install lld (LLVM linker) - required for cross-compiling init binary
install_lld() {
    print_step "Checking for lld... "
    if command_exists lld; then
        print_success "Found"
    elif brew_installed "lld"; then
        print_success "Already installed (brew)"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install lld
        print_success "lld installed"
    fi
    echo ""
}

# Install llvm (libclang) - required for bindgen
install_llvm() {
    print_step "Checking for llvm... "

    # Check if llvm-config exists (user may have installed llvm manually)
    if command_exists llvm-config; then
        print_success "Found ($(llvm-config --version))"
    elif brew_installed "llvm"; then
        print_success "Already installed (brew)"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install llvm
        print_success "llvm installed"
    fi
    echo ""
}

# Install dylibbundler
install_dylibbundler() {
    print_step "Checking for dylibbundler... "
    if brew_installed "dylibbundler"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install dylibbundler
        print_success "dylibbundler installed"
    fi
    echo ""
}

# Install protobuf (for boxlite-shared gRPC/protobuf compilation)
install_protobuf() {
    print_step "Checking for protobuf... "
    if brew_installed "protobuf"; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        brew install protobuf
        print_success "protobuf installed"
    fi
    echo ""
}

# Setup Python
setup_python() {
    if ! check_python; then
        echo -e "${YELLOW}Installing...${NC}"
        brew install python@3.11
        print_success "Python installed"
    fi
    echo ""
}

# Setup Go (with version validation)
setup_go() {
    if [ "${SKIP_INSTALL_GO:-}" = "1" ]; then
        print_step "Skipping Go (SKIP_INSTALL_GO=1)"
        echo ""
        return 0
    fi

    local status=0
    check_go || status=$?

    case "$status" in
        0)
            # Version OK
            ;;
        1)
            # Missing
            echo -e "${YELLOW}Installing...${NC}"
            brew install go
            print_success "Go installed"
            ;;
        2)
            # Too old
            echo -e "${YELLOW}Upgrading...${NC}"
            brew upgrade go
            print_success "Go upgraded"
            ;;
    esac
    echo ""
}

# Node.js install delegates to setup_nodejs in setup-common.sh.
# Local alias kept so the main flow reads the same on every platform.
install_nodejs() {
    setup_nodejs
}

# Main installation flow
main() {
    print_header "BoxLite Development Setup for macOS"

    check_platform

    print_section "📋 Checking prerequisites..."
    echo ""

    setup_homebrew
    echo ""

    update_homebrew

    init_submodules

    setup_rust

    setup_rust_target

    install_musl_cross

    setup_musl_linker

    install_dtc

    install_lld

    install_llvm

    install_dylibbundler

    install_protobuf

    setup_python

    setup_go

    install_nodejs

    run_dev_extras

    print_header "Setup Complete"
}

main "$@"
