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

# Install cargo-nextest
install_cargo_nextest() {
    print_step "Checking for cargo-nextest... "
    if cargo nextest --version &>/dev/null; then
        print_success "Already installed"
    else
        echo -e "${YELLOW}Installing...${NC}"
        cargo install cargo-nextest --locked
        print_success "cargo-nextest installed"
    fi
    echo ""
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

# Resolve PREK_VERSION from environment with a stable default.
setup_prek_version() {
    if [ -z "${PREK_VERSION:-}" ]; then
        export PREK_VERSION="0.3.3"
    fi
}

# Install pinned prek in best-effort mode.
install_prek_best_effort() {
    if [ "${CI:-}" = "true" ]; then
        print_info "CI detected, skipping prek installation"
        return 0
    fi

    setup_prek_version

    # Source cargo env if available to make freshly installed cargo visible.
    if [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
        source "${CARGO_HOME:-$HOME/.cargo}/env"
    fi

    if ! command_exists cargo; then
        print_warning "cargo not found; skipping prek installation"
        return 0
    fi

    local current_prek_version
    current_prek_version=$(prek --version 2>/dev/null | awk '{print $2}')

    if [ "$current_prek_version" = "$PREK_VERSION" ]; then
        print_success "prek $PREK_VERSION already installed"
        return 0
    fi

    print_step "Installing prek $PREK_VERSION... "
    if cargo install --locked prek --version "$PREK_VERSION"; then
        print_success "installed"
    else
        print_warning "Failed to install prek $PREK_VERSION; continuing without hook bootstrap"
    fi
}

# Install repository git hooks in best-effort mode.
install_git_hooks_best_effort() {
    if [ "${CI:-}" = "true" ]; then
        print_info "CI detected, skipping git hook installation"
        return 0
    fi

    local root_dir="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
    local git_dir="$root_dir/.git"
    local config_path="$root_dir/.pre-commit-config.yaml"

    if [ ! -d "$git_dir" ]; then
        print_warning ".git directory not found at $git_dir; skipping hook installation"
        return 0
    fi

    if [ ! -f "$config_path" ]; then
        print_warning ".pre-commit-config.yaml not found at $config_path; skipping hook installation"
        return 0
    fi

    if ! command_exists prek; then
        print_warning "prek not available; skipping hook installation"
        return 0
    fi

    print_step "Installing pre-commit and pre-push hooks... "
    if (cd "$root_dir" && prek install -t pre-commit -t pre-push --overwrite); then
        print_success "installed"
    else
        print_warning "Hook installation failed; continuing setup"
    fi
}

# Install Node SDK dev dependencies (prettier, etc.)
install_node_sdk_deps() {
    local sdk_dir="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}/sdks/node"
    if [ ! -d "$sdk_dir" ]; then
        return 0
    fi
    print_step "Installing Node SDK dependencies... "
    if [ -d "$sdk_dir/node_modules" ]; then
        print_success "Already installed"
    else
        (cd "$sdk_dir" && npm install --silent)
        print_success "Installed"
    fi
}

# Bootstrap prek and hooks as non-fatal setup steps.
bootstrap_prek_and_hooks() {
    install_prek_best_effort
    install_git_hooks_best_effort
}

# True when running in build-only mode.
is_build_mode() {
    [ "${BOXLITE_SETUP_MODE:-dev}" = "build" ]
}

# Run dev/test-only steps (no-op in build-only mode).
run_dev_extras() {
    if is_build_mode; then
        return 0
    fi

    install_cargo_nextest

    if command_exists npm; then
        install_node_sdk_deps
    fi

    bootstrap_prek_and_hooks
}
