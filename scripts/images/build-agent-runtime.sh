#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPS_DIR="$ROOT_DIR/apps"

TAG="${TAG:-20260605-p0-r3}"
REGISTRY="${REGISTRY:-ghcr.io/boxlite-ai}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUSH="${PUSH:-0}"

case "$PLATFORM" in
  linux/amd64) GOARCH=amd64 ;;
  linux/arm64) GOARCH=arm64 ;;
  *)
    echo "Unsupported PLATFORM=$PLATFORM; expected linux/amd64 or linux/arm64" >&2
    exit 1
    ;;
esac

DAEMON_OUT="$APPS_DIR/dist/apps/daemon-runtime/boxlite-daemon"
mkdir -p "$(dirname "$DAEMON_OUT")"

echo "==> Building daemon runtime binary for $PLATFORM"
(
  cd "$APPS_DIR"
  GOOS=linux GOARCH="$GOARCH" CGO_ENABLED=0 \
    go build -o "$DAEMON_OUT" ./daemon/cmd/daemon/main.go
)

file "$DAEMON_OUT"

build_args=(buildx build --platform "$PLATFORM")
if [[ "$PUSH" == "1" || "$PUSH" == "true" ]]; then
  build_args+=(--push)
else
  build_args+=(--load)
fi

for image in base python node; do
  dockerfile="$ROOT_DIR/images/agent-runtime/${image}.Dockerfile"
  target="$REGISTRY/boxlite-agent-${image}:$TAG"

  echo "==> Building $target from $dockerfile"
  docker "${build_args[@]}" -f "$dockerfile" -t "$target" "$ROOT_DIR"
done
