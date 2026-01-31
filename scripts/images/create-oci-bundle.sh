#!/bin/bash
# Create a filtered OCI layout bundle for testing (multi-arch by default).
# Style aligned with other scripts in scripts/build/.
#
# Usage:
#   ./scripts/create-test-oci-bundle.sh [--image IMAGE] [--output DIR] [--platforms LIST]
#     --image      Image reference (default: alpine:latest)
#     --output     Destination directory (default: ./test-oci-bundle)
#     --platforms  Comma-separated list (default: linux/amd64,linux/arm64)
#
# Examples:
#   ./scripts/create-test-oci-bundle.sh --image alpine:latest --output /tmp/alpine-bundle
#   ./scripts/create-test-oci-bundle.sh --image debian:bookworm-slim --output ~/Downloads/init-rootfs-bundle
#   ./scripts/create-test-oci-bundle.sh --image python:3.12 --platforms linux/amd64
#
# Requirements (multi-arch path):
#   - skopeo
#   - python3
#
# Docker fallback (host arch only) requires Docker >= 25.0.0 (OCI layout support).

set -euo pipefail

SCRIPT_IMAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_IMAGES_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Defaults
IMAGE="alpine:latest"
OUTPUT_DIR="./test-oci-bundle"
PLATFORMS_INPUT="linux/amd64,linux/arm64"

version_gte() {
    # Returns 0 if $1 >= $2 (portable, no sort -V needed)
    local IFS=.
    local -a a=($1) b=($2)
    for ((i = 0; i < ${#b[@]}; i++)); do
        local ai="${a[i]:-0}" bi="${b[i]:-0}"
        if ((ai > bi)); then return 0; fi
        if ((ai < bi)); then return 1; fi
    done
    return 0
}

docker_supports_oci_save() {
    # Docker Engine 25.0.0 added OCI-compliant tarball output for `docker save`.
    local ver
    ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker version --format '{{.Client.Version}}' 2>/dev/null || true)
    if [[ -z "$ver" ]]; then
        return 1
    fi
    version_gte "$ver" "25.0.0"
}

image_exists_locally() {
    command_exists docker && docker image inspect "$1" &>/dev/null
}

normalize_image_ref() {
    # Append :latest if no tag or digest is present.
    # Handles: "alpine" -> "alpine:latest", "alpine:3.20" unchanged, "img@sha256:..." unchanged
    local ref="$1"
    if [[ "$ref" != *@* && "$ref" != *:* ]]; then
        echo "${ref}:latest"
    else
        echo "$ref"
    fi
}

ensure_image_pulled() {
    if image_exists_locally "$1"; then
        print_info "Image found locally: $1"
    else
        print_info "Pulling image: $1"
        docker pull "$1"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --image)
                IMAGE="$2"; shift 2 ;;
            --output)
                OUTPUT_DIR="$2"; shift 2 ;;
            --platforms)
                PLATFORMS_INPUT="$2"; shift 2 ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--image IMG] [--output DIR] [--platforms list]"
                exit 1 ;;
        esac
    done
}

abs_path() {
    local p="$1"
    if [[ "$p" = /* ]]; then
        echo "$p"
    else
        echo "$(pwd)/$p"
    fi
}

print_header "Create OCI Bundle"

parse_args "$@"
IMAGE="$(normalize_image_ref "$IMAGE")"
OUTPUT_DIR="$(abs_path "$OUTPUT_DIR")"

print_info "Image:      $IMAGE"
print_info "Output dir: $OUTPUT_DIR"
print_info "Platforms:  $PLATFORMS_INPUT"
echo ""

prepare_output() {
    rm -rf "$OUTPUT_DIR"
}

prune_with_python() {
    OUTPUT_DIR="$OUTPUT_DIR" PLATFORMS="$PLATFORMS_INPUT" python3 - <<'PY'
import json, hashlib, os, pathlib, sys

root = pathlib.Path(os.environ["OUTPUT_DIR"])
platforms = os.environ.get("PLATFORMS", "linux/amd64,linux/arm64").split(",")
platform_set = {tuple(p.split("/", 1)) for p in platforms}

idx_path = root / "index.json"
outer_index = json.loads(idx_path.read_text())
if not outer_index.get("manifests"):
    sys.exit("index.json has no manifests")

descriptor = outer_index["manifests"][0]
if descriptor.get("mediaType") != "application/vnd.oci.image.index.v1+json":
    sys.exit("Expected outer manifest to reference an ImageIndex (multi-arch)")

blobdir = root / "blobs" / "sha256"
child_index_path = blobdir / descriptor["digest"].split(":", 1)[1]
child_index = json.loads(child_index_path.read_text())

filtered = [
    m for m in child_index.get("manifests", [])
    if m.get("platform", {}).get("os")
    and (m["platform"]["os"], m["platform"].get("architecture")) in platform_set
]
if not filtered:
    sys.exit(f"No manifests match platforms: {platforms}")

new_child = {"schemaVersion": 2, "manifests": filtered}
new_child_bytes = json.dumps(new_child, separators=(",", ":")).encode()
new_child_digest = hashlib.sha256(new_child_bytes).hexdigest()
new_child_size = len(new_child_bytes)
new_child_path = blobdir / new_child_digest
new_child_path.write_bytes(new_child_bytes)

outer_index = {
    "schemaVersion": 2,
    "manifests": [
        {
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "digest": f"sha256:{new_child_digest}",
            "size": new_child_size,
            "annotations": {"org.opencontainers.image.ref.name": "latest"},
        }
    ],
}
idx_path.write_text(json.dumps(outer_index, separators=(",", ":")))

keep = {new_child_digest}

def add_digest(d):
    keep.add(d.split(":", 1)[1])

def add_manifest(desc):
    add_digest(desc["digest"])
    manifest = json.loads((blobdir / desc["digest"].split(":", 1)[1]).read_text())
    add_digest(manifest["config"]["digest"])
    for layer in manifest["layers"]:
        add_digest(layer["digest"])

for desc in filtered:
    add_manifest(desc)

removed = 0
for blob in blobdir.iterdir():
    if blob.name not in keep:
        blob.unlink()
        removed += 1

print(f"Filtered platforms: {', '.join(platforms)}")
print(f"Kept blobs: {len(keep)}, removed: {removed}")
print(f"New inner index digest: sha256:{new_child_digest}")
PY
}

docker_host_uri() {
    # Resolve the Docker socket URI for tools (like skopeo) that don't use docker contexts.
    if [[ -n "${DOCKER_HOST:-}" ]]; then
        echo "$DOCKER_HOST"
        return
    fi
    docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null
}

build_with_skopeo() {
    print_section "Using skopeo"
    require_command "skopeo" "Install skopeo for multi-arch bundles"

    if image_exists_locally "$IMAGE"; then
        print_info "Copying from local Docker daemon (host arch only)"
        local dhost
        dhost=$(docker_host_uri) || true
        skopeo copy ${dhost:+--src-daemon-host "$dhost"} "docker-daemon:$IMAGE" "oci:$OUTPUT_DIR:latest"
    else
        print_info "Copying from registry (multi-arch)"
        require_command "python3" "Needed for pruning platforms"
        skopeo copy --multi-arch=all "docker://$IMAGE" "oci:$OUTPUT_DIR:latest"
        prune_with_python
    fi
    print_success "OCI bundle created at: $OUTPUT_DIR"
}

build_with_docker() {
    print_section "Using docker (host arch only)"
    require_command "docker" "Install Docker or skopeo"

    ensure_image_pulled "$IMAGE"

    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf '$temp_dir'" EXIT

    if ! docker save --platform "$PLATFORMS_INPUT" "$IMAGE" -o "$temp_dir/image.tar" 2>/dev/null; then
        print_warning "docker save --platform failed; retrying without platform filter (host arch only)"
        docker save "$IMAGE" -o "$temp_dir/image.tar"
    fi

    mkdir -p "$OUTPUT_DIR"
    tar -xf "$temp_dir/image.tar" -C "$OUTPUT_DIR"

    if [[ ! -f "$OUTPUT_DIR/oci-layout" ]]; then
        print_error "docker save did not produce an OCI layout (missing oci-layout file)"
        exit 1
    fi

    print_warning "Multi-arch pruning not available without skopeo; bundle contains host arch only."
    print_success "OCI bundle created at: $OUTPUT_DIR"
}

main() {
    prepare_output

    if command_exists docker && docker_supports_oci_save; then
        build_with_docker
    elif command_exists skopeo; then
        build_with_skopeo
    else
        print_error "No supported tool found to create OCI bundles."
        print_info "Option 1: Install Docker >= 25.0.0 (docker save with OCI layout)"
        print_info "Option 2: Install skopeo (multi-arch support)"
        exit 1
    fi
}

main "$@"
