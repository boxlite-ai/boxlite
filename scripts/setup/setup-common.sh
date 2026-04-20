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

# Configure sudo helper for scripts that write system locations.
setup_sudo() {
    if [ "$EUID" -eq 0 ]; then
        SUDO=""
    elif command_exists sudo; then
        SUDO="sudo"
    else
        SUDO=""
    fi

    export SUDO
}

# Fail early when a setup flow needs system-level package installation.
require_root_or_sudo() {
    setup_sudo

    if [ "$EUID" -ne 0 ] && [ -z "$SUDO" ]; then
        print_error "This setup requires root privileges or sudo"
        echo "   Re-run as root or install sudo and retry"
        exit 1
    fi
}

# Run a command through sudo when the current shell is not root.
run_with_sudo() {
    if [ -n "${SUDO:-}" ]; then
        "$SUDO" "$@"
    else
        "$@"
    fi
}

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

# Minimum Go version required by libgvproxy-sys go.mod
GO_MIN_MAJOR=1
GO_MIN_MINOR=24

# Check Go installation and version.
# Returns: 0 = OK, 1 = missing, 2 = too old
check_go() {
    print_step "Checking for Go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR}... "

    if ! command_exists go; then
        print_error "Not found"
        return 1
    fi

    local go_version
    go_version=$(go version | awk '{print $3}' | sed 's/go//')

    local major minor
    major=$(echo "$go_version" | cut -d. -f1)
    minor=$(echo "$go_version" | cut -d. -f2)

    if [ "$major" -gt "$GO_MIN_MAJOR" ] 2>/dev/null ||
       { [ "$major" -eq "$GO_MIN_MAJOR" ] 2>/dev/null && [ "$minor" -ge "$GO_MIN_MINOR" ] 2>/dev/null; }; then
        print_success "Found (version $go_version)"
        return 0
    else
        echo -e "${YELLOW}Found Go $go_version (too old, need >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR})${NC}"
        return 2
    fi
}

# Install Go from official go.dev tarball (Linux only).
install_go_from_official() {
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  arch="amd64" ;;
        aarch64) arch="arm64" ;;
        *)
            print_error "Unsupported architecture for Go: $arch"
            return 1
            ;;
    esac

    print_step "Fetching latest Go version... "
    local go_version
    go_version=$(curl -sL https://go.dev/VERSION?m=text | head -1)
    if [ -z "$go_version" ]; then
        print_error "Failed to fetch Go version from go.dev"
        return 1
    fi
    print_success "$go_version"

    local tarball="${go_version}.linux-${arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"

    print_step "Downloading ${tarball}... "
    local tmpfile="/tmp/${tarball}"
    if ! curl -sSL "$url" -o "$tmpfile"; then
        print_error "Failed to download Go from $url"
        return 1
    fi
    print_success "Done"

    print_step "Installing to /usr/local/go... "
    run_with_sudo rm -rf /usr/local/go
    run_with_sudo tar -C /usr/local -xzf "$tmpfile"
    rm -f "$tmpfile"
    print_success "Installed"

    # Ensure /usr/local/go/bin is in PATH for this session
    export PATH="/usr/local/go/bin:$PATH"

    # Persist PATH for future shells
    local path_line='export PATH="/usr/local/go/bin:$PATH"'
    local actual_user="${SUDO_USER:-$USER}"
    local user_home
    user_home=$(eval echo "~$actual_user")

    for profile in "$user_home/.profile" "$user_home/.bashrc"; do
        if [ -f "$profile" ] && ! grep -q '/usr/local/go/bin' "$profile"; then
            echo "" >> "$profile"
            echo "# Added by boxlite setup — Go from go.dev" >> "$profile"
            echo "$path_line" >> "$profile"
        fi
    done

    local installed_version
    installed_version=$(go version | awk '{print $3}' | sed 's/go//')
    print_success "Go $installed_version installed"
    print_info "Run 'source ~/.profile' or open a new terminal to use Go everywhere"
}

# Setup Go with version validation.
# On Linux: installs from go.dev if missing or too old.
# Respects SKIP_INSTALL_GO=1 to skip entirely.
setup_go() {
    if [ "${SKIP_INSTALL_GO:-}" = "1" ]; then
        print_step "Skipping Go (SKIP_INSTALL_GO=1)"
        echo ""
        return 0
    fi

    print_section "🐹 Checking Go..."

    # Prefer /usr/local/go/bin if it exists (official install location)
    if [ -d "/usr/local/go/bin" ]; then
        export PATH="/usr/local/go/bin:$PATH"
    fi

    local status=0
    check_go || status=$?

    case "$status" in
        0)
            # Version OK
            ;;
        1)
            # Missing — install automatically
            install_go_from_official
            ;;
        2)
            # Too old — ask user (auto-install in CI)
            if [ "${CI:-}" = "true" ]; then
                install_go_from_official
            else
                echo ""
                echo "   libgvproxy requires Go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR}."
                echo "   The build will fail without a compatible Go version."
                echo ""
                read -rp "   Upgrade Go from go.dev? [y/N] " answer
                case "$answer" in
                    [yY]|[yY][eE][sS])
                        install_go_from_official
                        ;;
                    *)
                        print_warning "Skipping Go upgrade. To upgrade manually:"
                        echo "   sudo rm -rf /usr/local/go"
                        echo "   wget https://go.dev/dl/go1.24.linux-\$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz"
                        echo "   sudo tar -C /usr/local -xzf go1.24.*.tar.gz"
                        echo "   export PATH=/usr/local/go/bin:\$PATH"
                        ;;
                esac
            fi
            ;;
    esac
    echo ""
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
