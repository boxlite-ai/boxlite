#!/usr/bin/env bash
# Smoke-test the C ABI used by the Go SDK prebuilt static library.

set -euo pipefail

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

LIB="${1:-target/release/libboxlite.a}"
REPO_ROOT="$PROJECT_ROOT"

if [[ "$LIB" != /* ]]; then
    LIB="$REPO_ROOT/$LIB"
fi

if [[ ! -f "$LIB" ]]; then
    print_error "Library not found: $LIB"
    exit 1
fi

require_command cc "Install a C compiler"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROBE_C="$TMP_DIR/check-libboxlite-abi.c"
PROBE_BIN="$TMP_DIR/check-libboxlite-abi"

cat > "$PROBE_C" <<'C'
#include "boxlite.h"
#include <stdio.h>

int main(void) {
    CBoxliteOptions *opts = NULL;
    CBoxliteError err = {0};

    enum BoxliteErrorCode new_code = boxlite_options_new(
        "ghcr.io/boxlite-ai/boxlite-agent-base:latest",
        &opts,
        &err
    );
    enum BoxliteErrorCode port_code = boxlite_options_add_port(
        opts,
        33689,
        2280,
        BoxlitePortProtocolTcp,
        NULL
    );

    printf("new=%d add_port=%d\n", (int)new_code, (int)port_code);
    if (opts != NULL) {
        boxlite_options_free(opts);
    }

    return (new_code == Ok && port_code == Ok) ? 0 : 1;
}
C

OS="$(detect_os)"
case "$OS" in
    linux)
        LINK_FLAGS=(-lresolv -lpthread -ldl -lrt -lm)
        ;;
    macos)
        LINK_FLAGS=(-framework CoreFoundation -framework Security -framework IOKit -framework Hypervisor -framework vmnet -lresolv)
        ;;
    *)
        print_error "Unsupported platform: $(uname -s)"
        exit 1
        ;;
esac

cc -I"$REPO_ROOT/sdks/c/include" "$PROBE_C" "$LIB" "${LINK_FLAGS[@]}" -o "$PROBE_BIN"

set +e
OUTPUT="$("$PROBE_BIN" 2>&1)"
STATUS=$?
set -e
echo "$OUTPUT"

if [[ "$STATUS" -ne 0 || "$OUTPUT" != "new=0 add_port=0" ]]; then
    print_error "libboxlite ABI smoke check failed for $LIB"
    exit 1
fi

print_success "libboxlite ABI smoke check passed for $LIB"
