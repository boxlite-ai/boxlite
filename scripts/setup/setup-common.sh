#!/bin/bash
# Common utilities for BoxLite setup scripts
#
# This file should be sourced by setup scripts, not executed directly.
# Usage: source scripts/setup-common.sh

# Exit if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "❌ Error: This script should be sourced, not executed directly"
    echo "Usage: source scripts/setup-common.sh"
    exit 1
fi

# Ensure common.sh is loaded
if [[ -z "$SCRIPT_DIR" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    source "$SCRIPT_DIR/common.sh"
fi

# Check Rust installation
check_rust() {
    print_step "Checking for Rust... "

    # Source cargo env if not already in PATH
    if ! command_exists rustc; then
        [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ] && source "${CARGO_HOME:-$HOME/.cargo}/env"
    fi

    if command_exists rustc; then
        local rust_version=$(rustc --version | cut -d' ' -f2)
        print_success "Found (version $rust_version)"
        return 0
    else
        print_error "Not found"
        return 1
    fi
}

# Install Rust
install_rust() {
    echo ""
    print_section "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "${CARGO_HOME:-$HOME/.cargo}/env"
    print_success "Rust installed"
}

# Initialize git submodules
init_submodules() {
    print_step "Checking git submodules... "

    # Check if we're in a git repository
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not in a git repository"
        return 1
    fi

    # Check if submodules are already initialized
    if git submodule status | grep -q "^-"; then
        echo -e "${YELLOW}Initializing...${NC}"
        git submodule update --init --recursive --depth 1
        print_success "Submodules initialized"
    else
        print_success "Already initialized"
    fi
}

# Detect guest target architecture
detect_guest_target() {
    source "$SCRIPT_DIR/util.sh"
    export GUEST_TARGET
}

# Check and add Rust target
check_rust_target() {
    local target="$1"

    print_step "Checking for $target target... "
    if rustup target list | grep -q "$target (installed)"; then
        print_success "Already installed"
        return 0
    else
        echo -e "${YELLOW}Installing...${NC}"
        rustup target add "$target"
        print_success "Target installed"
        return 0
    fi
}

# Check Python installation
check_python() {
    print_step "Checking for Python 3... "
    if command_exists python3; then
        local python_version=$(python3 --version | cut -d' ' -f2)
        print_success "Found (version $python_version)"
        return 0
    else
        print_error "Not found"
        return 1
    fi
}

# Check Go installation
check_go() {
    print_step "Checking for Go... "
    if command_exists go; then
        local go_version=$(go version | awk '{print $3}' | sed 's/go//')
        print_success "Found (version $go_version)"
        return 0
    else
        print_error "Not found"
        return 1
    fi
}

# Check Node.js installation
check_nodejs() {
    print_step "Checking for Node.js... "
    if command_exists node; then
        local node_version=$(node --version)
        print_success "Found ($node_version)"
        return 0
    else
        print_error "Not found"
        return 1
    fi
}

# Check if musl toolchain is available (fail fast)
require_musl() {
    local os=$(detect_os)
    if [ "$os" = "macos" ]; then
        # macOS: check for musl-cross (e.g., x86_64-linux-musl-gcc or aarch64-linux-musl-gcc)
        if ! command_exists x86_64-linux-musl-gcc && ! command_exists aarch64-linux-musl-gcc; then
            print_error "musl-cross toolchain not found"
            echo "   Run: scripts/setup/setup-macos.sh"
            exit 1
        fi
    else
        # Linux: check for musl-gcc
        if ! command_exists musl-gcc; then
            print_error "musl-gcc not found"
            echo "   Run: scripts/setup/setup-ubuntu.sh (or setup-musllinux.sh)"
            exit 1
        fi
    fi
}
