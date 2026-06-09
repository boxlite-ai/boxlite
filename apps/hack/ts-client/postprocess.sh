#!/usr/bin/env bash
set -euo pipefail

client_dir="${1:?client directory is required}"

if [ ! -d "$client_dir" ]; then
  echo "TS API client directory does not exist: $client_dir" >&2
  exit 1
fi

yarn prettier --write "$client_dir/**/*.ts"
