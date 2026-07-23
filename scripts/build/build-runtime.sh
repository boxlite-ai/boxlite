#!/bin/bash
# Assemble the BoxLite runtime from pre-built assets, shim, and guest binaries.

set -e

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_BUILD_DIR/common.sh"

PROFILE="${BUILD_PROFILE:-release}"

print_help() {
    cat <<EOF
Usage: $0 [--profile debug|release]

Assemble pre-built BoxLite components into a runtime containing:
  - runtime assets from scripts/build/build-runtime-assets.sh
  - boxlite-shim
  - boxlite-guest

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

if [ ! -d "$DEST_DIR" ]; then
    echo "Required runtime assets not found: $DEST_DIR" >&2
    echo "Build the runtime through make so its prerequisites run first." >&2
    exit 1
fi

cp "$SHIM_BINARY" "$GUEST_BINARY" "$DEST_DIR/"

if ! find "$DEST_DIR" -maxdepth 1 -type f -name 'libkrunfw.*' -print -quit | grep -q .; then
    echo "No libkrunfw runtime assets found in $DEST_DIR" >&2
    exit 1
fi

if [ "$(detect_os)" = "macos" ]; then
    "$SCRIPT_BUILD_DIR/sign.sh" "$DEST_DIR/boxlite-shim"
fi

printf 'Runtime assembled at %s\n' "$DEST_DIR"
