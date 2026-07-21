#!/bin/bash
# Assemble the BoxLite runtime from pre-built shim and guest binaries.

set -e

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

PROFILE="${BUILD_PROFILE:-release}"

print_help() {
    cat <<EOF
Usage: $0 [--profile debug|release]

Assemble pre-built BoxLite components into a runtime containing:
  - boxlite-shim
  - boxlite-guest
  - packaged libkrunfw artifacts, when enabled

Use make runtime to build prerequisites. Output is written to
target/boxlite-runtime/<profile>.

BUILD_PROFILE also selects the profile; the default is release.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --profile)
            if [ -z "${2:-}" ]; then
                echo "--profile requires debug or release" >&2
                exit 2
            fi
            PROFILE=$2
            shift 2
            ;;
        --help|-h)
            print_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            print_help >&2
            exit 2
            ;;
    esac
done

set_cargo_profile "$PROFILE"
CARGO_TARGET_ROOT=$(cargo_target_dir)
DEST_DIR="$CARGO_TARGET_ROOT/boxlite-runtime/$PROFILE"
# shellcheck source=../util.sh
source "$SCRIPT_DIR/util.sh"
SHIM_BINARY="$CARGO_TARGET_ROOT/$PROFILE/boxlite-shim"
GUEST_BINARY="$CARGO_TARGET_ROOT/$GUEST_TARGET/$PROFILE/boxlite-guest"

for binary in "$SHIM_BINARY" "$GUEST_BINARY"; do
    if [ ! -f "$binary" ]; then
        echo "Required runtime binary not found: $binary" >&2
        echo "Build the runtime through make so its prerequisites run first." >&2
        exit 1
    fi
done

cargo_args=(build --lib -p boxlite --message-format=json)
if [ -n "$CARGO_PROFILE_ARG" ]; then
    cargo_args+=("$CARGO_PROFILE_ARG")
fi

cd "$PROJECT_ROOT"
rm -rf "$DEST_DIR"
cargo_messages=$(mktemp)
trap 'rm -f "$cargo_messages"' EXIT INT TERM
cargo "${cargo_args[@]}" >"$cargo_messages"

# Use awk instead of nested sed address blocks: the latter works with GNU sed
# but fails on the BSD sed shipped with macOS.
runtime_src=$(awk '
    /"reason":"build-script-executed"/ && /\/src\/boxlite#/ {
        line = $0
        sub(/^.*"out_dir":"/, "", line)
        sub(/".*$/, "", line)
        print line
    }
' "$cargo_messages" | tail -1)
if [ -z "$runtime_src" ] || [ ! -d "$runtime_src/runtime" ]; then
    echo "Cargo did not report a BoxLite runtime directory" >&2
    exit 1
fi
runtime_src="$runtime_src/runtime"

mkdir -p "$DEST_DIR"
cp -a "$runtime_src/." "$DEST_DIR/"
cp "$SHIM_BINARY" "$GUEST_BINARY" "$DEST_DIR/"

krunfw_count=0
while IFS= read -r -d '' asset; do
    cp "$asset" "$DEST_DIR/"
    krunfw_count=$((krunfw_count + 1))
done < <(find "$CARGO_TARGET_ROOT" -maxdepth 1 -type f -name 'libkrunfw.*' -print0)

if [ "$krunfw_count" -eq 0 ]; then
    echo "No libkrunfw runtime assets found in $CARGO_TARGET_ROOT" >&2
    exit 1
fi

printf 'Copied %d libkrunfw asset(s)\n' "$krunfw_count"

if [ "$(detect_os)" = "macos" ]; then
    "$SCRIPT_BUILD_DIR/sign.sh" "$DEST_DIR/boxlite-shim"
fi

printf 'Runtime assembled at %s\n' "$DEST_DIR"
