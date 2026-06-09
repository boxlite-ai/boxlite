#!/usr/bin/env bash
set -euo pipefail

client_dir="${1:?client directory is required}"

if [ ! -d "$client_dir" ]; then
  echo "Go API client directory does not exist: $client_dir" >&2
  exit 1
fi

gofmt -w "$client_dir"/*.go
