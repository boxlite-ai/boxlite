#!/usr/bin/env bash
# Build a local Linux amd64 runner release artifact without deploying it.

set -euo pipefail

SCRIPT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_BUILD_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

REPO_ROOT="$PROJECT_ROOT"
VERSION="${VERSION:-$(grep -m 1 '^version' "$REPO_ROOT/Cargo.toml" | sed -E 's/^version *= *"([^"]+)".*/\1/')}"
COMMIT="${COMMIT:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist/runner-release}"
RUNNER_BIN="$OUTPUT_DIR/boxlite-runner"
RUNNER_TARBALL="$OUTPUT_DIR/boxlite-runner-v${VERSION}-linux-amd64-${COMMIT}.tar.gz"

if [[ -z "$VERSION" ]]; then
    print_error "Could not read version from $REPO_ROOT/Cargo.toml"
    exit 1
fi

if [[ "$(detect_os)" != "linux" ]]; then
    print_error "Runner release artifacts must be built on Linux because the binary uses cgo"
    exit 1
fi

require_command git "Install git"
require_command go "Install Go"
require_command tar "Install tar"
require_command sha256sum "Install coreutils"

if [[ "${SKIP_SUBMODULE_UPDATE:-0}" != "1" ]]; then
    print_section "Updating submodules"
    git -C "$REPO_ROOT" submodule update --init --recursive
fi

print_section "Building and validating Go SDK static library"
make -C "$REPO_ROOT" dist:go
bash "$SCRIPT_BUILD_DIR/check-libboxlite-abi.sh" "$REPO_ROOT/sdks/go/libboxlite.a"

print_section "Building embedded daemon assets"
cd "$REPO_ROOT/apps"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags "-X github.com/boxlite-ai/daemon/internal.Version=${VERSION}" \
    -o "$REPO_ROOT/apps/runner/pkg/daemon/static/daemon-amd64" \
    ./daemon/cmd/daemon/

CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
    go build \
    -o "$REPO_ROOT/apps/runner/pkg/daemon/static/boxlite-computer-use" \
    ./libs/computer-use/

print_section "Building runner"
mkdir -p "$OUTPUT_DIR"
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags "-X github.com/boxlite-ai/runner/internal.Version=${VERSION}" \
    -o "$RUNNER_BIN" \
    ./runner/cmd/runner/

tar -C "$OUTPUT_DIR" -czf "$RUNNER_TARBALL" "$(basename "$RUNNER_BIN")"

print_success "Runner artifact built"
echo "binary:  $RUNNER_BIN"
echo "tarball: $RUNNER_TARBALL"
sha256sum "$RUNNER_BIN" "$RUNNER_TARBALL"
