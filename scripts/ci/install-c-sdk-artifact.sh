#!/usr/bin/env bash
# Install libboxlite.a from one downloaded Linux AMD64 C SDK artifact.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <artifact-directory> <destination-libboxlite.a>" >&2
  exit 2
fi

artifact_dir=$1
destination=$2
[[ -d "$artifact_dir" ]] || {
  echo "error: C SDK artifact directory not found: $artifact_dir" >&2
  exit 1
}

shopt -s nullglob
archives=("$artifact_dir"/boxlite-c-v*-linux-x64-gnu.tar.gz)
if [[ ${#archives[@]} -ne 1 ]]; then
  echo "error: expected exactly one Linux AMD64 C SDK archive, found ${#archives[@]}" >&2
  exit 1
fi

members=()
while IFS= read -r member; do
  if [[ "$member" =~ ^boxlite-c-v[^/]+-linux-x64-gnu/lib/libboxlite\.a$ ]]; then
    members+=("$member")
  fi
done < <(tar -tzf "${archives[0]}")
if [[ ${#members[@]} -ne 1 ]]; then
  echo "error: expected exactly one libboxlite.a in the C SDK archive, found ${#members[@]}" >&2
  exit 1
fi

mkdir -p "$(dirname "$destination")"
temporary=$(mktemp "${destination}.installing.XXXXXX")
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

tar -xOzf "${archives[0]}" "${members[0]}" >"$temporary"
ar t "$temporary" >/dev/null
chmod 0644 "$temporary"
mv -f "$temporary" "$destination"
trap - EXIT
