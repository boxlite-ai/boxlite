#!/bin/bash
# Common utilities for BoxLite scripts
#
# This file should be sourced by other scripts, not executed directly.
# Usage: source scripts/common.sh

# Exit if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "❌ Error: This script should be sourced, not executed directly"
    echo "Usage: source scripts/common.sh"
    exit 1
fi

# Script directory helpers
export SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/colors.sh"

# Print header
print_header() {
    local title="$1"
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}${BOLD}↓  ${title}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Print section header
print_section() {
    echo -e "${CYAN}${BOLD}↘ $1${NC}"
}

# Print step (inline, no newline)
print_step() {
    echo -n "$1"
}

# Print success
print_success() {
    echo -e "${GREEN}${BOLD}✓ $1${NC}"
}

# Print error
print_error() {
    echo -e "${WHITE}${BG_RED}✗ $1${NC}"
}

# Print warning
print_warning() {
    echo -e "${WHITE}${BG_PURPLE}❕ $1${NC}"
}

# Print info
print_info() {
    echo -e "${BLUE}→ $1${NC}"
}

# Check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Ensure cargo is in PATH (sources cargo env if available)
ensure_cargo() {
    if [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
        source "${CARGO_HOME:-$HOME/.cargo}/env"
    fi
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    else
        echo "unknown"
    fi
}

# Install Rust if not available
install_rust() {
    if ! command -v cargo &> /dev/null; then
        echo "📦 Installing Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

        # Source Rust environment
        if [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
            source "${CARGO_HOME:-$HOME/.cargo}/env"
        else
            echo "❌ ERROR: Rust installation failed"
            exit 1
        fi

        echo "✅ Rust installed: $(rustc --version)"
    else
        echo "✅ Rust already installed: $(rustc --version)"
    fi
}

# Require a command, fail with helpful message if missing
require_command() {
    local cmd="$1"
    local hint="$2"
    if ! command_exists "$cmd"; then
        print_error "Required command not found: $cmd"
        if [ -n "$hint" ]; then
            echo "   $hint"
        fi
        exit 1
    fi
}
