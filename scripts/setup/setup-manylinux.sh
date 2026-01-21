#!/bin/bash
# Setup script for BoxLite development on manylinux containers
#
# This script installs all required dependencies for building BoxLite in
# manylinux containers (used by cibuildwheel for portable wheel builds).
# Run this once when setting up a manylinux build environment.
#
# Usage:
#   bash scripts/setup/setup-manylinux.sh

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

# Check if a yum package is installed
yum_installed() {
    yum list installed "$1" &>/dev/null
}

# Update package lists
update_yum() {
    print_section "🔄 Updating package lists..."
    yum update -y -q
    echo ""
}

# Install system dependencies
install_system_deps() {
    print_section "📦 Installing system dependencies..."

    local packages=(
        # Core build tools
        gcc
        gcc-c++
        make
        git
        curl
        unzip
        file               # file type detection
        pkgconfig
        openssl-devel

        # libkrun build dependencies
        clang
        clang-devel
        llvm
        llvm-devel
        libatomic
        libepoxy-devel      # Required by rutabaga_gfx for OpenGL
        virglrenderer-devel # Required by rutabaga_gfx for GPU virtualization

        # libkrunfw kernel build dependencies
        bc
        bison
        flex
        elfutils-libelf-devel  # libelf.h, gelf.h
        ncurses-devel
        kmod
        cpio
        rsync
        patch

        # libgvproxy (Go network backend)
        golang

        # bubblewrap build dependencies (jailer sandbox)
        ninja-build        # Ninja build backend
        libcap-devel       # Linux capabilities library

        # Python
        python3
        python3-pip
    )

    for pkg in "${packages[@]}"; do
        print_step "Checking for $pkg... "
        if yum_installed "$pkg"; then
            print_success "Already installed"
        else
            echo -e "${YELLOW}Installing...${NC}"
            yum install -y -q "$pkg"
            print_success "$pkg installed"
        fi
    done

    # Try to install glibc-static if available (not critical, not available on all arches)
    print_step "Checking for glibc-static (optional)... "
    if yum install -y -q glibc-static 2>/dev/null; then
        print_success "Installed"
    else
        echo -e "${YELLOW}Not available (not required)${NC}"
    fi

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
        pip3 install -q pyelftools
        print_success "pyelftools installed"
    fi

    # Meson build system (for bubblewrap)
    print_step "Checking for meson... "
    if command -v meson &>/dev/null; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing via pip...${NC}"
        pip3 install -q meson
        print_success "meson installed"
    fi
    echo ""
}

# Install protoc from GitHub releases (manylinux has old protoc without proto3 optional support)
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

# Install Node.js from nodejs.org (not available in manylinux repos)
install_nodejs() {
    if [ "${SKIP_INSTALL_NODEJS:-}" = "1" ]; then
        print_step "Skipping Node.js (SKIP_INSTALL_NODEJS=1)"
        echo ""
        return 0
    fi

    print_section "📦 Installing Node.js..."

    local NODE_VERSION="20.18.0"
    local ARCH=$(uname -m)

    # Map architecture names to Node.js naming convention
    case "$ARCH" in
        x86_64)  NODE_ARCH="x64" ;;
        aarch64) NODE_ARCH="arm64" ;;
        *)
            print_error "Unsupported architecture: $ARCH"
            return 1
            ;;
    esac

    print_step "Checking for Node.js... "
    if command -v node &>/dev/null; then
        local version=$(node --version)
        print_success "Found ($version)"
        echo ""
        return 0
    fi

    echo -e "${YELLOW}Downloading Node.js $NODE_VERSION...${NC}"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1
    print_success "Node.js $NODE_VERSION installed"
    echo ""
}

# Main installation flow
main() {
    print_header "BoxLite Development Setup for manylinux"

    check_platform

    print_section "📋 Checking prerequisites..."
    echo ""

    update_yum

    install_system_deps

    install_python_deps

    install_protoc

    install_nodejs

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
