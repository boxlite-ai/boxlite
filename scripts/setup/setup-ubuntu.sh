#!/bin/bash
# Setup script for BoxLite development on Ubuntu/Debian
#
# This script installs all required dependencies for building BoxLite on Linux.
# Run this once when setting up a new development environment.
#
# Usage:
#   bash scripts/setup/setup-ubuntu.sh

set -e

# Source common utilities
SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SETUP_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SETUP_DIR/setup-common.sh"

# Check if running on Linux
check_platform() {
    if [[ "$(uname)" != "Linux" ]]; then
        print_error "This script is for Linux only"
        echo "   For macOS, use: bash scripts/setup/setup-macos.sh"
        exit 1
    fi

    # Warn if running in manylinux container
    if command -v yum >/dev/null 2>&1 && ! command -v apt-get >/dev/null 2>&1; then
        print_error "This script is for Ubuntu/Debian systems"
        echo "   For manylinux/RHEL/CentOS, use: bash scripts/setup/setup-manylinux.sh"
        exit 1
    fi
}

# Check if we need $SUDO (not root and $SUDO exists)
if [ "$EUID" -ne 0 ] && command -v sudo &> /dev/null; then
    SUDO="sudo"
else
    SUDO=""
fi

# Check if a package is installed
apt_installed() {
    dpkg -l "$1" 2>/dev/null | grep -q "^ii"
}

# Update package lists
update_apt() {
    print_section "🔄 Updating package lists..."
    $SUDO apt-get update -qq
    echo ""
}

# Install system dependencies
install_system_deps() {
    print_section "📦 Installing system dependencies..."

    local packages=(
        # Core build tools
        build-essential    # gcc, g++, make
        git
        curl
        wget
        file               # file type detection
        pkg-config
        patchelf           # ELF binary patching for wheel repair

        # Rust/cargo dependencies
        libssl-dev         # OpenSSL development headers

        # Guest binary (static musl build)
        musl-tools         # musl-gcc for static linking

        # Python SDK
        python3
        python3-pip
        python3-venv

        # libgvproxy (Go network backend)
        golang-go

        # libkrun build dependencies
        llvm               # llvm-config for clang-sys
        libclang-dev       # libclang.so for bindgen

        # libkrunfw kernel build dependencies
        flex               # Lexical analyzer (kernel build)
        bison              # Parser generator (kernel build)
        bc                 # Calculator (kernel build)
        libelf-dev         # ELF library (kernel objtool)
        python3-pyelftools # ELF parsing (bin2cbundle.py)

        # bubblewrap build dependencies (jailer sandbox)
        meson              # Meson build system
        ninja-build        # Ninja build backend
        libcap-dev         # Linux capabilities library

        # gRPC/protobuf (boxlite-shared)
        protobuf-compiler  # protoc compiler
    )

    for pkg in "${packages[@]}"; do
        print_step "Checking for $pkg... "
        if apt_installed "$pkg"; then
            print_success "Already installed"
        else
            echo -e "${YELLOW}Installing...${NC}"
            $SUDO apt-get install -y -qq "$pkg"
            print_success "$pkg installed"
        fi
    done
    echo ""
}

# Install Node.js
install_nodejs() {
    if [ "${SKIP_INSTALL_NODEJS:-}" = "1" ]; then
        print_step "Skipping Node.js (SKIP_INSTALL_NODEJS=1)"
        echo ""
        return 0
    fi

    print_section "📦 Installing Node.js..."

    local packages=(nodejs npm)

    for pkg in "${packages[@]}"; do
        print_step "Checking for $pkg... "
        if apt_installed "$pkg"; then
            print_success "Already installed"
        else
            echo -e "${YELLOW}Installing...${NC}"
            $SUDO apt-get install -y -qq "$pkg"
            print_success "$pkg installed"
        fi
    done
    echo ""
}

# Install linuxdeploy
install_linuxdeploy() {
    print_section "📦 Installing linuxdeploy..."

    local linuxdeploy_url="https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage"
    local install_dir="/usr/local/bin"
    local linuxdeploy_bin="$install_dir/linuxdeploy"

    print_step "Checking for linuxdeploy... "
    if [ -f "$linuxdeploy_bin" ]; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Downloading...${NC}"
        $SUDO wget -q "$linuxdeploy_url" -O "$linuxdeploy_bin"
        $SUDO chmod +x "$linuxdeploy_bin"
        print_success "linuxdeploy installed"
    fi
    echo ""
}

# Main installation flow
main() {
    local actual_user="${SUDO_USER:-$USER}"

    print_header "BoxLite Development Setup for Ubuntu/Debian"

    check_platform

    print_section "📋 Checking prerequisites..."
    echo ""

    update_apt

    install_system_deps

    install_nodejs

    install_linuxdeploy

    init_submodules

    # Track if Rust was just installed
    local rust_just_installed=false
    if ! check_rust; then
        install_rust
        rust_just_installed=true
    fi

    detect_guest_target
    check_rust_target "$GUEST_TARGET"

    print_header "Setup Complete"
}

main "$@"
