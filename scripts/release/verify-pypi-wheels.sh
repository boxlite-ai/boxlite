#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
mode=${1:?expected before or after}
[[ "$mode" == before || "$mode" == after ]]
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
index=$(mktemp)
trap 'rm -f "$index"' EXIT
status=$(curl -sS --retry 5 --retry-all-errors -o "$index" -w '%{http_code}' "https://pypi.org/pypi/boxlite/${TAG#v}/json")
if [[ "$status" == 404 && "$mode" == before ]]; then exit 0; fi
[[ "$status" == 200 ]] || { echo "PyPI lookup for $TAG returned HTTP $status" >&2; exit 1; }
jq -e '.urls | type == "array"' "$index" >/dev/null
for wheel in dist/*.whl; do
  sha=$(sha256sum "$wheel" | cut -d' ' -f1)
  jq -e --arg name "${wheel##*/}" --arg sha "$sha" --arg mode "$mode" '
    [.urls[] | select(.filename == $name)] |
    if length == 0 then $mode == "before" else all(.[]; .digests.sha256 == $sha) end' "$index" >/dev/null ||
    { echo "PyPI has a missing or conflicting accepted wheel: ${wheel##*/}" >&2; exit 1; }
done
