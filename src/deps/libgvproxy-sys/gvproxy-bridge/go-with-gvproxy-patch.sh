#!/usr/bin/env bash
# Build or test against a private copy of the pinned gvisor-tap-vsock module.
set -euo pipefail
readonly MODULE=github.com/containers/gvisor-tap-vsock
readonly VERSION=v0.8.7

case "${1:-}" in
  build|test|vet) operation=$1; shift ;;
  *) printf 'usage: %s {build|test|vet} [go arguments]\n' "$0" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")"
export GOWORK=off
mode=readonly
if [[ -d vendor ]]; then
  mode=vendor
fi
selected=$(go list -m -mod="$mode" -f '{{.Version}}' "$MODULE")
if [[ "$selected" != "$VERSION" ]]; then
  printf 'gvisor-tap-vsock DNS patch expects %s, found %s\n' "$VERSION" "$selected" >&2
  exit 1
fi
if [[ "$mode" == vendor ]]; then
  upstream="$PWD/vendor/$MODULE"
else
  go mod download "$MODULE@$VERSION"
  module_cache=$(go env GOMODCACHE)
  upstream="$module_cache/$MODULE@$VERSION"
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-gvproxy.XXXXXXXX")
trap 'chmod -R u+w "$scratch" && rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -R "$upstream" "$scratch/upstream"
chmod -R u+w "$scratch/upstream/pkg"
patch_file="$PWD/gvisor-tap-vsock-dns.patch"
ipv6_patch_file="$PWD/gvisor-tap-vsock-ipv6.patch"
(
  # The command may run from a Git hook. Apply only to the temporary module.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
  export GIT_CEILING_DIRECTORIES="$scratch"
  cd "$scratch/upstream"
  git apply "$patch_file"
  git apply "$ipv6_patch_file"
)
if [[ "$mode" == vendor ]]; then
  host_os=$(go env GOHOSTOS)
  host_arch=$(go env GOHOSTARCH)
  GOOS="$host_os" GOARCH="$host_arch" CGO_ENABLED=0 GOFLAGS= go run -mod=vendor write-vendor-overlay.go \
    "$upstream" "$scratch/upstream" > "$scratch/overlay.json"
  go "$operation" -mod=vendor -overlay="$scratch/overlay.json" "$@"
else
  cp go.mod "$scratch/bridge.mod"
  cp go.sum "$scratch/bridge.sum"
  go mod edit -modfile="$scratch/bridge.mod" -replace="$MODULE=$scratch/upstream"
  go "$operation" -mod=readonly -modfile="$scratch/bridge.mod" "$@"
fi
