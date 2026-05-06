#!/bin/bash
# Cross-compile gvproxy DLL for Windows x86_64 from macOS.
#
# Prerequisites: brew install mingw-w64
#
# Output:
#   target/kernel-windows-x86_64/gvproxy.dll   (runtime DLL, ~25 MB)
#   target/kernel-windows-x86_64/gvproxy.lib   (MSVC import library, ~6 KB)
#
# Usage on Windows build:
#   set LIBGVPROXY_PREBUILT=C:\ws-boxlite\runtime\gvproxy.lib
#   (also place gvproxy.dll next to boxlite-shim.exe or in runtime dir)
#   cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun,gvproxy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/src/deps/libgvproxy-sys/gvproxy-bridge"
OUTPUT_DIR="$REPO_ROOT/target/kernel-windows-x86_64"

CC="${CC:-x86_64-w64-mingw32-gcc}"
DLLTOOL="${DLLTOOL:-x86_64-w64-mingw32-dlltool}"

# Verify cross-compiler and dlltool
for tool in "$CC" "$DLLTOOL"; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Install with: brew install mingw-w64" >&2
        exit 1
    fi
done

mkdir -p "$OUTPUT_DIR"

echo "Cross-compiling gvproxy DLL for Windows x86_64..."
echo "  Source: $SOURCE_DIR"
echo "  Output: $OUTPUT_DIR/"
echo "  CC: $CC"

cd "$SOURCE_DIR"

# Download dependencies
go mod download

# Build as shared library (DLL) for Windows x86_64.
#
# c-shared produces a DLL where Go's internal linker handles all MinGW/.pdata
# internally. This avoids the LNK1223 (.pdata) error that occurs when MSVC's
# link.exe tries to link a c-archive containing Go's go.o object file.
#
# IMPORTANT: The DLL approach is REQUIRED on Windows. The static c-archive
# (libgvproxy.lib) hangs on Win11 during Go's _cgo_wait_runtime_init_done().
CGO_ENABLED=1 \
GOOS=windows \
GOARCH=amd64 \
CC="$CC" \
go build -buildmode=c-shared -o "$OUTPUT_DIR/gvproxy.dll" .

echo "DLL built: $(ls -lh "$OUTPUT_DIR/gvproxy.dll" | awk '{print $5}')"

# Create MSVC-compatible import library from exported symbols.
# dlltool generates a small .lib (~6 KB) that tells MSVC's link.exe which
# functions to resolve from gvproxy.dll at runtime.
cat > "$OUTPUT_DIR/gvproxy.def" << 'DEFEOF'
LIBRARY gvproxy.dll
EXPORTS
    gvproxy_set_log_callback
    gvproxy_create
    gvproxy_destroy
    gvproxy_get_stats
    gvproxy_get_version
    gvproxy_free_string
DEFEOF

"$DLLTOOL" -d "$OUTPUT_DIR/gvproxy.def" -l "$OUTPUT_DIR/gvproxy.lib" --dllname gvproxy.dll

echo "Import lib: $(ls -lh "$OUTPUT_DIR/gvproxy.lib" | awk '{print $5}')"

# Clean up intermediate files
rm -f "$OUTPUT_DIR/gvproxy.def" "$OUTPUT_DIR/gvproxy.h"

echo ""
echo "Done! Files:"
ls -lh "$OUTPUT_DIR/gvproxy.dll" "$OUTPUT_DIR/gvproxy.lib"
echo ""
echo "To use on Windows:"
echo "  1. Copy gvproxy.dll to C:\\ws-boxlite\\runtime\\"
echo "  2. Copy gvproxy.lib to C:\\ws-boxlite\\runtime\\"
echo "  3. set LIBGVPROXY_PREBUILT=C:\\ws-boxlite\\runtime\\gvproxy.lib"
echo "  4. cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun,gvproxy"
