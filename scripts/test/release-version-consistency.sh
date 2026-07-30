#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

workspace_version=$(awk '
  /^\[workspace\.package\]$/ { in_package = 1; next }
  /^\[/ { in_package = 0 }
  in_package && /^version = "/ { gsub(/^version = "|"$/, ""); print; exit }
' Cargo.toml)
[[ -n "$workspace_version" ]] || {
  echo "error: workspace version not found in Cargo.toml" >&2
  exit 1
}

node_version=$(node -p 'require("./sdks/node/package.json").version')
root_node_range=$(node -p 'require("./package.json").dependencies["@boxlite-ai/boxlite"]')
python_version=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdks/python/pyproject.toml | head -1)

for declaration in "$node_version" "$python_version"; do
  if [[ "$declaration" != "$workspace_version" ]]; then
    echo "error: release version $declaration does not match Cargo workspace $workspace_version" >&2
    exit 1
  fi
done
if [[ "$root_node_range" != "^$workspace_version" ]]; then
  echo "error: root Node dependency $root_node_range does not match ^$workspace_version" >&2
  exit 1
fi

echo "release versions are consistent: $workspace_version"
