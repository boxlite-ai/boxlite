#!/bin/bash
# Fix Go runtime symbol conflicts in libboxlite.a
#
# libgvproxy (a Go c-archive) is statically linked into libboxlite.a,
# bringing Go runtime symbols that conflict with the Go SDK binary's own
# runtime. This script localizes those symbols so the Go binary's runtime
# takes precedence.
#
# Requires: llvm-objcopy (LLVM 20+ on macOS, LLVM 9+ on Linux)
#
# Usage:
#   ./fix-go-symbols.sh <path/to/libboxlite.a>

set -e

# Load common utilities
SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

LIB="${1:?Usage: fix-go-symbols.sh <path/to/libboxlite.a>}"

if [ ! -f "$LIB" ]; then
    print_error "Library not found: $LIB"
    exit 1
fi

# Resolve llvm-objcopy per platform.
OS=$(detect_os)
case "$OS" in
    macos)
        OBJCOPY="${LLVM_OBJCOPY:-$(/opt/homebrew/bin/brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)/bin/llvm-objcopy}"
        ;;
    linux)
        OBJCOPY="${LLVM_OBJCOPY:-llvm-objcopy}"
        ;;
    *)
        print_error "Unsupported platform: $(uname -s)"
        exit 1
        ;;
esac

require_command "$OBJCOPY" "Install LLVM (brew install llvm on macOS)"

# CGo bridge symbols from embedded libgvproxy conflict with the Go SDK
# binary's own runtime. Localizing them lets the binary's runtime win.
#
# We use --wildcard with [a-z] character classes to match Go runtime symbols
# (_cgo_panic, x_cgo_init, crosscall2, etc.) while preserving package-specific
# CGo function bridges (_cgo_<hash>_Cfunc_*) which start with a hex digit.
#
# On Linux ELF, the embedded Go c-archive also has .init_array constructors
# that try to start a second Go runtime, causing a segfault. Removing the
# section prevents double-init while the main binary's runtime handles
# everything (same Go version, same ABI).
case "$OS" in
    linux)
        "$OBJCOPY" \
            --remove-section .init_array \
            --wildcard \
            --localize-symbol='_cgo_[a-z]*' \
            --localize-symbol='x_cgo_*' \
            --localize-symbol='crosscall*' \
            "$LIB"
        ;;
    macos)
        "$OBJCOPY" \
            --wildcard \
            --localize-symbol='__cgo_[a-z]*' \
            --localize-symbol='_x_cgo_*' \
            --localize-symbol='_crosscall*' \
            "$LIB"
        ;;
esac

print_success "Go symbols fixed in $(basename "$LIB")"
