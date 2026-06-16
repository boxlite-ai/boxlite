#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPS_DIR="$ROOT_DIR/apps"
DAEMON_OUT_DIR="$APPS_DIR/dist/apps/daemon-runtime"
VERSION_FILE="$ROOT_DIR/images/agent-runtime/VERSION"

REGISTRY="${REGISTRY:-ghcr.io/boxlite-ai}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-0}"

read_runtime_image_version() {
  if [[ ! -f "$VERSION_FILE" ]]; then
    echo "Missing runtime image version file: $VERSION_FILE" >&2
    exit 1
  fi
  tr -d '[:space:]' < "$VERSION_FILE"
}

normalize_tag() {
  local version tag

  if [[ -n "${TAG:-}" ]]; then
    tag="$TAG"
  else
    version="${VERSION:-$(read_runtime_image_version)}"
    if [[ -z "$version" ]]; then
      echo "Unable to derive version from $VERSION_FILE; set TAG or VERSION" >&2
      exit 1
    fi
    tag="v${version#v}"
  fi

  if [[ "$tag" != v* ]]; then
    tag="v$tag"
  fi

  if [[ ! "$tag" =~ ^v[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "Invalid TAG=$tag; expected vMAJOR.MINOR.PATCH" >&2
    exit 1
  fi

  printf '%s\n' "$tag"
}

platform_to_arch() {
  case "$1" in
    linux/amd64) printf 'amd64\n' ;;
    linux/arm64) printf 'arm64\n' ;;
    *)
      echo "Unsupported platform '$1'; expected linux/amd64 or linux/arm64" >&2
      exit 1
      ;;
  esac
}

split_platforms() {
  local raw="$1"
  local -a out=()
  IFS=',' read -ra out <<< "$raw"
  for platform in "${out[@]}"; do
    if [[ -z "$platform" ]]; then
      echo "Invalid empty platform in PLATFORMS=$raw" >&2
      exit 1
    fi
    platform_to_arch "$platform" >/dev/null
  done
  printf '%s\n' "${out[@]}"
}

build_daemon() {
  local platform="$1"
  local arch
  arch="$(platform_to_arch "$platform")"

  mkdir -p "$DAEMON_OUT_DIR"

  echo "==> Building daemon runtime binary for $platform"
  (
    cd "$APPS_DIR"
    GOOS=linux GOARCH="$arch" CGO_ENABLED=0 \
      go build -o "$DAEMON_OUT_DIR/boxlite-daemon-$arch" ./daemon/cmd/daemon/
  )

  file "$DAEMON_OUT_DIR/boxlite-daemon-$arch"
}

build_image() {
  local image="$1"
  local tag="$2"
  local dockerfile="$ROOT_DIR/images/agent-runtime/${image}.Dockerfile"
  local target="$REGISTRY/boxlite-agent-${image}:$tag"
  local -a build_args=(buildx build --platform "$PLATFORMS" -f "$dockerfile" -t "$target")

  if [[ ! -f "$dockerfile" ]]; then
    echo "Missing Dockerfile: $dockerfile" >&2
    exit 1
  fi

  if [[ "$PUSH" == "1" || "$PUSH" == "true" ]]; then
    build_args+=(--push)
  elif [[ "${#REQUESTED_PLATFORMS[@]}" -eq 1 ]]; then
    build_args+=(--load)
  else
    build_args+=(--output=type=cacheonly)
  fi

  echo "==> Building $target from $dockerfile for $PLATFORMS"
  docker "${build_args[@]}" "$ROOT_DIR"
}

TAG="$(normalize_tag)"
REQUESTED_PLATFORMS=()
while IFS= read -r platform; do
  REQUESTED_PLATFORMS+=("$platform")
done < <(split_platforms "$PLATFORMS")

for platform in "${REQUESTED_PLATFORMS[@]}"; do
  build_daemon "$platform"
done

for image in base python node; do
  build_image "$image" "$TAG"
done
