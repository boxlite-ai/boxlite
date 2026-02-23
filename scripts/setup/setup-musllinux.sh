#!/bin/bash
# Setup script for BoxLite development on musllinux containers
#
# This script installs all required dependencies for building BoxLite in
# musllinux containers (used by cibuildwheel for portable wheel builds).
# Run this once when setting up a musllinux build environment.
#
# Usage:
#   bash scripts/setup/setup-musllinux.sh

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
        echo "   For Ubuntu/Debian, use: bash scripts/setup/setup-ubuntu.sh"
        exit 1
    fi
}

# Check if an apk package is installed
apk_installed() {
    apk info -e "$1" &>/dev/null
}

# Update package lists
update_apk() {
    print_section "🔄 Updating package lists..."
    apk update
    echo ""
}

# Install system dependencies
install_system_deps() {
    print_section "📦 Installing system dependencies..."

    local packages=(
        # Core build tools
        gcc
        g++
        make
        git
        curl
        unzip
        file               # file type detection
        pkgconfig
        openssl-dev

        # musl development
        musl-dev

        # libkrun build dependencies
        clang
        clang-dev
        llvm
        llvm-dev
        libatomic
        libepoxy-dev      # Required by rutabaga_gfx for OpenGL
        virglrenderer-dev # Required by rutabaga_gfx for GPU virtualization

        # libkrunfw kernel build dependencies
        bc
        bison
        flex
        elfutils-dev      # libelf.h, gelf.h
        ncurses-dev
        kmod
        cpio
        rsync
        patch
        perl              # Required for kernel build

        # libgvproxy (Go network backend)
        go

        # Python
        python3
        python3-dev
        py3-pip
    )

    for pkg in "${packages[@]}"; do
        print_step "Checking for $pkg... "
        if apk_installed "$pkg"; then
            print_success "Already installed"
        else
            echo -e "${YELLOW}Installing...${NC}"
            apk add --quiet "$pkg"
            print_success "$pkg installed"
        fi
    done

    echo ""
}

# Install Python dependencies
install_python_deps() {
    print_section "📦 Installing Python dependencies..."

    print_step "Checking for pyelftools... "
    if python3 -c "import elftools" 2>/dev/null; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        pip3 install --quiet pyelftools
        print_success "pyelftools installed"
    fi
    echo ""
}

# Install protoc from GitHub releases (musllinux may have old protoc without proto3 optional support)
install_protoc() {
    print_section "📦 Installing protoc..."

    local PROTOC_VERSION="29.3"
    local ARCH=$(uname -m)

    # Map architecture names
    case "$ARCH" in
        x86_64)  PROTOC_ARCH="x86_64" ;;
        aarch64) PROTOC_ARCH="aarch_64" ;;
        *)
            print_error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac

    print_step "Checking for protoc >= 3.15... "

    # Check if protoc exists and supports optional (requires 3.15+)
    if command -v protoc &>/dev/null; then
        local version=$(protoc --version | grep -oE '[0-9]+\.[0-9]+')
        local major=$(echo "$version" | cut -d. -f1)
        if [ "$major" -ge 3 ]; then
            local minor=$(echo "$version" | cut -d. -f2)
            if [ "$major" -gt 3 ] || [ "$minor" -ge 15 ]; then
                print_success "Found protoc $version"
                return 0
            fi
        fi
        echo -e "${YELLOW}Found protoc $version (too old, need 3.15+)${NC}"
    else
        echo -e "${YELLOW}Not found${NC}"
    fi

    print_step "Downloading protoc $PROTOC_VERSION... "
    local PROTOC_URL="https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${PROTOC_ARCH}.zip"
    local PROTOC_ZIP="/tmp/protoc.zip"

    curl -sSL "$PROTOC_URL" -o "$PROTOC_ZIP"
    unzip -q -o "$PROTOC_ZIP" -d /usr/local
    rm -f "$PROTOC_ZIP"

    print_success "Installed protoc $PROTOC_VERSION"
    echo ""
}

# Main installation flow
main() {
    print_header "BoxLite Development Setup for musllinux"

    check_platform

    print_section "📋 Checking prerequisites..."
    echo ""

    update_apk

    install_system_deps

    install_python_deps

    install_protoc

    init_submodules

    # Track if Rust was just installed
    local rust_just_installed=false
    if ! check_rust; then
        install_rust
        rust_just_installed=true
    fi

    detect_guest_target
    check_rust_target "$GUEST_TARGET"

    install_cargo_nextest

    print_header "Setup Complete"
}

main "$@"
