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

# Resolve llvm-objcopy and platform-specific symbol prefix.
# Mach-O adds a leading underscore to C symbols; ELF does not.
OS=$(detect_os)
case "$OS" in
    macos)
        OBJCOPY="${LLVM_OBJCOPY:-$(/opt/homebrew/bin/brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)/bin/llvm-objcopy}"
        P="_"
        ;;
    linux)
        OBJCOPY="${LLVM_OBJCOPY:-llvm-objcopy}"
        P=""
        ;;
    *)
        print_error "Unsupported platform: $(uname -s)"
        exit 1
        ;;
esac

require_command "$OBJCOPY" "Install LLVM (brew install llvm on macOS)"

# 20 CGo bridge symbols from embedded libgvproxy that conflict with
# the Go SDK binary's own runtime. Making them local resolves the conflict.
"$OBJCOPY" \
    --localize-symbol="${P}_cgo_panic" \
    --localize-symbol="${P}_cgo_topofstack" \
    --localize-symbol="${P}crosscall2" \
    --localize-symbol="${P}_cgo_release_context" \
    --localize-symbol="${P}_cgo_sys_thread_start" \
    --localize-symbol="${P}x_cgo_init" \
    --localize-symbol="${P}_cgo_get_context_function" \
    --localize-symbol="${P}_cgo_set_stacklo" \
    --localize-symbol="${P}_cgo_try_pthread_create" \
    --localize-symbol="${P}_cgo_wait_runtime_init_done" \
    --localize-symbol="${P}x_cgo_bindm" \
    --localize-symbol="${P}x_cgo_notify_runtime_init_done" \
    --localize-symbol="${P}x_cgo_set_context_function" \
    --localize-symbol="${P}x_cgo_sys_thread_create" \
    --localize-symbol="${P}x_cgo_setenv" \
    --localize-symbol="${P}x_cgo_unsetenv" \
    --localize-symbol="${P}x_cgo_getstackbound" \
    --localize-symbol="${P}x_cgo_callers" \
    --localize-symbol="${P}x_cgo_thread_start" \
    --localize-symbol="${P}crosscall1" \
    "$LIB"

print_success "Go symbols fixed in $(basename "$LIB")"
