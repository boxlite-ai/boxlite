#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/apps/dist/libs"

mkdir -p "$OUTPUT_DIR"

docker build \
  --platform linux/amd64 \
  --provenance=false \
  -f "$SCRIPT_DIR/Dockerfile" \
  --output "type=local,dest=$OUTPUT_DIR" \
  "$ROOT_DIR"
