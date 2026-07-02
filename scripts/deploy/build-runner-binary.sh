#!/usr/bin/env bash
# Build the Linux amd64 boxlite-runner tarball without GitHub Actions.
#
# Run this from the checkout you want to deploy. To deploy latest main to dev:
#   git checkout main
#   git pull --ff-only origin main
#   scripts/deploy/build-runner-binary.sh --output-dir dist
# The generated tarball is intentionally named
# `v{VERSION}-dev-{BUILD_SEQUENCE}-{GUEST_HASH}`. This script is for
# non-published builds, so the embedded runtime cache must not share the
# official release directory `v{VERSION}`.
#
# The runner is a cgo binary that links libboxlite.a. Build the embedded runtime
# inputs first (boxlite-shim + boxlite-guest), force boxlite's build.rs to rerun
# so those binaries are embedded, then build/stage the C SDK archive for Go.
#
# Usage:
#   scripts/deploy/build-runner-binary.sh
#   scripts/deploy/build-runner-binary.sh --output-dir /tmp
#   BOXLITE_RUNNER_BUILD_NUMBER=123 scripts/deploy/build-runner-binary.sh
#   scripts/deploy/build-runner-binary.sh --skip-setup

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/dist"
RUN_SETUP=1
BUILD_SEQUENCE="${BOXLITE_RUNNER_BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-}}"

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --output-dir DIR   Directory for the runner tarball. Default: ./dist
  --build-number ID  Ordered dev build sequence. Default: BOXLITE_RUNNER_BUILD_NUMBER,
                     GITHUB_RUN_NUMBER, or current UTC timestamp.
  --skip-setup       Skip `make setup:build`.
  -h, --help         Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || { echo "error: --output-dir requires a value" >&2; exit 1; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --build-number)
      [[ $# -ge 2 ]] || { echo "error: --build-number requires a value" >&2; exit 1; }
      BUILD_SEQUENCE="$2"
      shift 2
      ;;
    --skip-setup)
      RUN_SETUP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: required command not found: $1" >&2; exit 1; }
}

require_cmd cargo
require_cmd go
require_cmd make
require_cmd sha256sum
require_cmd tar

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "error: runner tarball build currently requires a Linux x86_64 builder" >&2
  exit 1
fi

VERSION="$(grep -m 1 '^version' "$ROOT_DIR/Cargo.toml" | sed -E 's/^version *= *"([^"]+)".*/\1/')"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from Cargo.toml" >&2
  exit 1
fi

if [[ -z "$BUILD_SEQUENCE" ]]; then
  BUILD_SEQUENCE="$(date -u +%Y%m%d%H%M%S)"
fi
BUILD_SEQUENCE="$(printf '%s' "$BUILD_SEQUENCE" | tr -c 'A-Za-z0-9._-' '-')"
BUILD_SEQUENCE="${BUILD_SEQUENCE#v}"
[[ -n "$BUILD_SEQUENCE" ]] || { echo "error: build sequence cannot be empty" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
GO_WORK_BACKUP="$TMP_DIR/go.work.backup"
GO_WORK_SUM_BACKUP="$TMP_DIR/go.work.sum.backup"
HAD_GO_WORK=0
HAD_GO_WORK_SUM=0

restore_go_work() {
  if [[ "$HAD_GO_WORK" -eq 1 ]]; then
    cp "$GO_WORK_BACKUP" "$ROOT_DIR/apps/go.work"
  else
    rm -f "$ROOT_DIR/apps/go.work"
  fi

  if [[ "$HAD_GO_WORK_SUM" -eq 1 ]]; then
    cp "$GO_WORK_SUM_BACKUP" "$ROOT_DIR/apps/go.work.sum"
  else
    rm -f "$ROOT_DIR/apps/go.work.sum"
  fi

  rm -rf "$TMP_DIR"
}
trap restore_go_work EXIT

if [[ -f "$ROOT_DIR/apps/go.work" ]]; then
  HAD_GO_WORK=1
  cp "$ROOT_DIR/apps/go.work" "$GO_WORK_BACKUP"
fi
if [[ -f "$ROOT_DIR/apps/go.work.sum" ]]; then
  HAD_GO_WORK_SUM=1
  cp "$ROOT_DIR/apps/go.work.sum" "$GO_WORK_SUM_BACKUP"
fi

GO_VERSION="$(awk '/^go / { print $2; exit }' "$ROOT_DIR/apps/runner/go.mod")"
if [[ -z "$GO_VERSION" ]]; then
  echo "error: could not read Go version from apps/runner/go.mod" >&2
  exit 1
fi

cat > "$ROOT_DIR/apps/go.work" <<EOF
go $GO_VERSION

use (
	./runner
	./common-go
	./api-client-go
	../sdks/go
)
EOF

echo "==> Building boxlite-runner from package v$VERSION at $(git rev-parse --short HEAD)"
echo "==> Non-release artifact version prefix: v${VERSION}-dev-${BUILD_SEQUENCE}"

echo "==> Cleaning runner build artifacts"
cargo clean -p boxlite -p boxlite-c -p boxlite-shim -p boxlite-guest
rm -f \
  "$ROOT_DIR/sdks/go/libboxlite.a" \
  "$ROOT_DIR/target/release/libboxlite.a" \
  "$ROOT_DIR/target/release/libboxlite.so" \
  "$ROOT_DIR/target/release/boxlite-shim"
rm -f "$ROOT_DIR/target/x86_64-unknown-linux-gnu/release/boxlite-shim"
rm -f "$ROOT_DIR/target/x86_64-unknown-linux-musl/release/boxlite-guest"
rm -rf "$ROOT_DIR/sdks/c/dist"

if [[ "$RUN_SETUP" -eq 1 ]]; then
  make setup:build
fi

scripts/build/build-shim.sh --profile release
scripts/build/build-guest.sh --profile release
GUEST_BIN="$ROOT_DIR/target/x86_64-unknown-linux-musl/release/boxlite-guest"
[[ -x "$GUEST_BIN" ]] || { echo "error: guest binary not found after build: $GUEST_BIN" >&2; exit 1; }
GUEST_SHA256="$(sha256sum "$GUEST_BIN" | awk '{print $1}')"
RUNTIME_SUFFIX="${GUEST_SHA256:0:12}"
RUNTIME_CACHE_SUFFIX="dev-${BUILD_SEQUENCE}-${RUNTIME_SUFFIX}"
RUNNER_VERSION="${VERSION}-${RUNTIME_CACHE_SUFFIX}"

echo "==> Building libboxlite with runtime cache key v${RUNNER_VERSION}"
BOXLITE_RUNTIME_CACHE_VERSION="$VERSION" \
  BOXLITE_RUNTIME_CACHE_SUFFIX="$RUNTIME_CACHE_SUFFIX" \
  make dist:c
cp "$ROOT_DIR/target/release/libboxlite.a" "$ROOT_DIR/sdks/go/libboxlite.a"

go -C apps/runner mod download
go -C apps/common-go mod download
go -C apps/api-client-go mod download

RUNNER_BIN="$TMP_DIR/boxlite-runner"
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -C apps \
  -ldflags "-X github.com/boxlite-ai/runner/internal.Version=${RUNNER_VERSION}" \
  -o "$RUNNER_BIN" ./runner/cmd/runner
printf '%s  boxlite-guest\n' "$GUEST_SHA256" > "$TMP_DIR/boxlite-runner.guest.sha256"
echo "==> Wrote guest hash sidecar ${GUEST_SHA256:0:12}"
printf '%s\n' "$RUNTIME_CACHE_SUFFIX" > "$TMP_DIR/boxlite-runner.runtime-suffix"
echo "==> Runtime cache directory: v${RUNNER_VERSION}"

mkdir -p "$OUTPUT_DIR"
TARBALL="$OUTPUT_DIR/boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz"
tar czf "$TARBALL" -C "$TMP_DIR" \
  boxlite-runner \
  boxlite-runner.guest.sha256 \
  boxlite-runner.runtime-suffix

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$TARBALL" > "$TARBALL.sha256"
else
  shasum -a 256 "$TARBALL" > "$TARBALL.sha256"
fi

echo "==> Wrote $TARBALL"
echo "==> Wrote $TARBALL.sha256"
