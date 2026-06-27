#!/usr/bin/env bash
set -euo pipefail # Fail fast on command errors, unset variables, and broken pipes.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" # Repository root, also the Docker build context.
VERSION_FILE="$ROOT_DIR/images/agent-runtime/VERSION" # Agent image release version source of truth.

REGISTRY="${REGISTRY:-ghcr.io/boxlite-ai}" # Target registry namespace for the three image packages.
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}" # Default publish target covers Intel and ARM Linux hosts.
PUSH="${PUSH:-0}" # PUSH=0 validates locally, PUSH=1 publishes to the registry.

read_runtime_image_version() { # Read 0.1.0-style version and let normalize_tag add the leading v.
  if [[ ! -f "$VERSION_FILE" ]]; then
    echo "Missing runtime image version file: $VERSION_FILE" >&2
    exit 1
  fi
  tr -d '[:space:]' < "$VERSION_FILE" # Strip newline so the value can be embedded in Docker tags.
}

normalize_tag() { # Accept TAG or VERSION overrides and normalize them to vMAJOR.MINOR.PATCH.
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

  if [[ ! "$tag" =~ ^v[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
    echo "Invalid TAG=$tag; expected vMAJOR.MINOR.PATCH with optional -PRERELEASE" >&2
    exit 1
  fi

  printf '%s\n' "$tag"
}

validate_platform() { # Accept only the CPU architectures BoxLite publishes for these images.
  case "$1" in
    linux/amd64 | linux/arm64) ;;
    *)
      echo "Unsupported platform '$1'; expected linux/amd64 or linux/arm64" >&2
      exit 1
      ;;
  esac
}

parse_platforms() { # Validate the comma-separated PLATFORMS input before any build starts.
  local raw="$1"
  REQUESTED_PLATFORMS=()
  IFS=',' read -ra REQUESTED_PLATFORMS <<< "$raw"
  for platform in "${REQUESTED_PLATFORMS[@]}"; do
    if [[ -z "$platform" ]]; then
      echo "Invalid empty platform in PLATFORMS=$raw" >&2
      exit 1
    fi
    validate_platform "$platform"
  done
}

build_image() { # Build or publish one of base, python, or node with the shared version tag.
  local image="$1"
  local tag="$2"
  local dockerfile="$ROOT_DIR/images/agent-runtime/${image}.Dockerfile" # Dockerfile selected by image flavor.
  local target="$REGISTRY/boxlite-agent-${image}:$tag" # Existing GHCR package name plus version tag.
  local -a build_args=(buildx build --platform "$PLATFORMS" -f "$dockerfile" -t "$target") # Common Buildx arguments.

  if [[ ! -f "$dockerfile" ]]; then
    echo "Missing Dockerfile: $dockerfile" >&2
    exit 1
  fi

  if [[ "$PUSH" == "1" || "$PUSH" == "true" ]]; then
    build_args+=(--push) # CI publish path writes the multi-arch manifest to GHCR.
  elif [[ "${#REQUESTED_PLATFORMS[@]}" -eq 1 ]]; then
    build_args+=(--load) # Single-platform local validation loads the image into Docker.
  else
    build_args+=(--output=type=cacheonly) # Multi-platform dry run validates build steps without pushing.
  fi

  echo "==> Building $target from $dockerfile for $PLATFORMS"
  docker "${build_args[@]}" "$ROOT_DIR"
}

TAG="$(normalize_tag)" # Final Docker tag such as v0.1.0.
REQUESTED_PLATFORMS=() # Parsed platform list used for validation and local output mode selection.
parse_platforms "$PLATFORMS"

for image in base python node; do
  build_image "$image" "$TAG" # Publish all three runtime variants with the same version tag.
done
