#!/usr/bin/env bash
# Run a bridge build, test, or vet against the same patched versions.
set -euo pipefail

case "${1:-}" in
  build|test|vet) operation=$1; shift ;;
  *) printf 'usage: %s {build|test|vet} [go arguments...]\n' "$0" >&2; exit 2 ;;
esac

bridge_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$bridge_dir"
workspace=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-gvproxy.XXXXXXXX")
trap 'rm -rf -- "$workspace"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
workspace=$(cd -- "$workspace" && pwd -P)
export GOWORK=off

modfile=
if [[ -d vendor ]]; then
  overlay_entries=()
else
  modfile="$workspace/bridge.mod"
  cp go.mod "$modfile"
  cp go.sum "$workspace/bridge.sum"
fi

# The vendor tree already has the rest of the required files. The Go overlay
# swaps only the patched sources and leaves both the vendor tree and cwd intact.
json_path() {
  if [[ $1 =~ [[:cntrl:]] ]]; then
    printf 'Unsupported control character in gvproxy build path\n' >&2
    return 1
  fi
  local escaped=${1//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf '"%s"' "$escaped"
}

prepare_dependency() {
  local module=$1 version=$2 file=$3 patch=$4
  local staged="$workspace/$module" actual source
  local version_format='{{.Version}}{{if .Replace}} (replaced){{end}}'
  if [[ -z $modfile ]]; then
    actual=$(go list -mod=vendor -m -f "$version_format" "$module")
  else
    actual=$(go list -mod=readonly "-modfile=$modfile" -m -f "$version_format" "$module")
  fi
  if [[ $actual != "$version" ]]; then
    printf 'gvproxy patch %s requires %s at %s, found %s\n' "$patch" "$module" "$version" "$actual" >&2
    return 1
  fi

  if [[ -z $modfile ]]; then
    source="vendor/$module/$file"
    mkdir -p "$staged/${file%/*}"
    cp "$source" "$staged/$file"
    chmod u+w "$staged/$file"
  else
    go mod download "-modfile=$modfile" "$module@$version"
    source=$(go list -mod=readonly "-modfile=$modfile" -m -f '{{.Dir}}' "$module")
    mkdir -p "${staged%/*}"
    cp -R "$source" "$staged"
    chmod -R u+w "$staged"
  fi
  GIT_CEILING_DIRECTORIES="$workspace" git -C "$staged" apply -- "$bridge_dir/patches/$patch"

  if [[ -z $modfile ]]; then
    local original_path patched_path
    original_path=$(json_path "$source")
    patched_path=$(json_path "$staged/$file")
    overlay_entries+=("$original_path:$patched_path")
  else
    go mod edit "-modfile=$modfile" "-replace=$module@$version=$staged"
  fi
}

prepare_dependency gvisor.dev/gvisor v0.0.0-20240916094835-a174eb65023f \
  pkg/tcpip/network/ipv4/ipv4.go gvisor-ipv4-owner.patch
prepare_dependency github.com/containers/gvisor-tap-vsock v0.8.7 \
  pkg/tap/switch.go tap-guest-frame-owner.patch

if [[ -z $modfile ]]; then
  (IFS=,; printf '{"Replace":{%s}}\n' "${overlay_entries[*]}") > "$workspace/vendor-overlay.json"
  go "$operation" -mod=vendor "-overlay=$workspace/vendor-overlay.json" "$@"
else
  go "$operation" -mod=readonly "-modfile=$modfile" "$@"
fi
