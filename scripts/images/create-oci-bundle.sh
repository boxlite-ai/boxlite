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
# Docker fallback (single-arch host only) is used if skopeo is unavailable.

set -euo pipefail

SCRIPT_IMAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SCRIPT_IMAGES_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

# Defaults
IMAGE="alpine:latest"
OUTPUT_DIR="./test-oci-bundle"
PLATFORMS_INPUT="linux/amd64,linux/arm64"

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

build_with_skopeo() {
    print_section "Using skopeo (multi-arch)"
    require_command "skopeo" "Install skopeo for multi-arch bundles"
    require_command "python3" "Needed for pruning platforms"

    skopeo copy --multi-arch=all "docker://$IMAGE" "oci:$OUTPUT_DIR:latest"
    prune_with_python
    print_success "OCI bundle created at: $OUTPUT_DIR"
}

build_with_docker() {
    print_section "Using docker fallback (single-arch host only)"
    require_command "docker" "Install Docker or skopeo"

    docker pull "$IMAGE"
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT

    local cid
    cid=$(docker create "$IMAGE")
    docker export "$cid" > "$temp_dir/rootfs.tar"
    docker rm "$cid" >/dev/null

    mkdir -p "$OUTPUT_DIR/blobs/sha256"

    local layer_digest layer_size
    layer_digest=$(sha256sum "$temp_dir/rootfs.tar" | cut -d' ' -f1)
    mv "$temp_dir/rootfs.tar" "$OUTPUT_DIR/blobs/sha256/$layer_digest"
    layer_size=$(stat -f%z "$OUTPUT_DIR/blobs/sha256/$layer_digest" 2>/dev/null || stat --printf="%s" "$OUTPUT_DIR/blobs/sha256/$layer_digest")

    local host_arch
    host_arch=$(uname -m)
    case "$host_arch" in
        x86_64) ARCH=amd64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) ARCH=$host_arch ;;
    esac

    local config_json config_digest config_size
    config_json='{"architecture":"'"$ARCH"'","os":"linux","config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"WorkingDir":"/"},"rootfs":{"type":"layers","diff_ids":["sha256:'"$layer_digest"'"]}}'
    config_digest=$(echo -n "$config_json" | sha256sum | cut -d' ' -f1)
    echo -n "$config_json" > "$OUTPUT_DIR/blobs/sha256/$config_digest"
    config_size=${#config_json}

    local manifest_json manifest_digest manifest_size
    manifest_json='{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:'"$config_digest"'","size":'"$config_size"'},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar","digest":"sha256:'"$layer_digest"'","size":'"$layer_size"'}]}'
    manifest_digest=$(echo -n "$manifest_json" | sha256sum | cut -d' ' -f1)
    echo -n "$manifest_json" > "$OUTPUT_DIR/blobs/sha256/$manifest_digest"
    manifest_size=${#manifest_json}

    echo '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:'"$manifest_digest"'","size":'"$manifest_size"',"platform":{"architecture":"'"$ARCH"'","os":"linux"}}]}' > "$OUTPUT_DIR/index.json"
    echo '{"imageLayoutVersion":"1.0.0"}' > "$OUTPUT_DIR/oci-layout"

    print_warning "Multi-arch pruning not available without skopeo; bundle contains host arch only."
    print_success "OCI bundle created at: $OUTPUT_DIR"
}

main() {
    prepare_output

    if command_exists skopeo; then
        build_with_skopeo
    else
        build_with_docker
    fi

    package_bundle
}

package_bundle() {
    local archive="${OUTPUT_DIR%/}.tar.zst"

    print_section "Packaging bundle"
    rm -f "$archive" "${OUTPUT_DIR%/}.tar.gz" 2>/dev/null || true

    if command_exists zstd; then
        print_info "Using zstd (fast + high ratio)"
        if command_exists gtar; then
            gtar -C "$(dirname "$OUTPUT_DIR")" \
                -I "zstd -T0 -19" \
                -cf "$archive" \
                "$(basename "$OUTPUT_DIR")"
        else
            (cd "$(dirname "$OUTPUT_DIR")" && \
                tar -cf - "$(basename "$OUTPUT_DIR")" | zstd -T0 -19 -o "$archive")
        fi
        print_success "Archive created: $archive"
    elif command_exists gzip; then
        print_warning "zstd not found, falling back to gzip"
        archive="${OUTPUT_DIR%/}.tar.gz"
        tar -C "$(dirname "$OUTPUT_DIR")" -zcf "$archive" "$(basename "$OUTPUT_DIR")"
        print_success "Archive created: $archive"
    else
        print_warning "No compressor (zstd/gzip) found; skipping archive"
    fi
}

main "$@"
