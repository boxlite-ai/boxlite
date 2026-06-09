#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/apps/dist/libs"

mkdir -p "$OUTPUT_DIR"

if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/amd64 \
    --provenance=false \
    -f "$SCRIPT_DIR/Dockerfile" \
    --output "type=local,dest=$OUTPUT_DIR" \
    "$ROOT_DIR"
  exit 0
fi

IMAGE_TAG="boxlite/computer-use-amd64-build:$(date +%s)-$$"
CONTAINER_ID=""

cleanup() {
  if [ -n "$CONTAINER_ID" ]; then
    docker rm "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  docker rmi "$IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build \
  --platform linux/amd64 \
  -f "$SCRIPT_DIR/Dockerfile" \
  --target export \
  -t "$IMAGE_TAG" \
  "$ROOT_DIR"

CONTAINER_ID="$(docker create "$IMAGE_TAG" /computer-use-amd64)"
docker cp "$CONTAINER_ID:/computer-use-amd64" "$OUTPUT_DIR/computer-use-amd64"
