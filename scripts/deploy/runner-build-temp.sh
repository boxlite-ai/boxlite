#!/usr/bin/env bash
# Build a dev-only runner artifact from the current checkout.
#
# This does not upload to GitHub Releases. The caller uploads the tarball to the
# dev deploy-artifacts bucket and passes a presigned URL to runner-rollout.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist/deploy}"
ENV_FILE="${OUTPUT_DIR}/runner-artifact.env"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--output-dir DIR]

Build a Linux amd64 boxlite-runner tarball from the current checkout.

Environment:
  RUNNER_TEMP_VERSION  Override artifact version string.

Outputs:
  DIR/boxlite-runner-<version>-linux-amd64.tar.gz
  DIR/runner-artifact.env
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="$2"
      ENV_FILE="${OUTPUT_DIR}/runner-artifact.env"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: temporary runner builds require Linux amd64 because the runner uses CGO" >&2
  echo "hint: run the Deploy Dev GitHub Action for runner_mode=temporary-build" >&2
  exit 1
fi

require_cmd git
require_cmd go
require_cmd make
require_cmd tar

cd "$REPO_ROOT"

BASE_VERSION=$(grep -m 1 '^version' Cargo.toml | sed -E 's/^version *= *"([^"]+)".*/\1/')
if [[ -z "$BASE_VERSION" ]]; then
  echo "error: could not read version from Cargo.toml" >&2
  exit 1
fi

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short=12 HEAD)
DIRTY_SUFFIX=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY_SUFFIX="-dirty"
fi
ARTIFACT_VERSION="${RUNNER_TEMP_VERSION:-${BASE_VERSION}-dev.${COMMIT_SHORT}${DIRTY_SUFFIX}}"
ARTIFACT_FILE="boxlite-runner-${ARTIFACT_VERSION}-linux-amd64.tar.gz"

mkdir -p "$OUTPUT_DIR"

echo "==> Building temporary runner artifact"
echo "    commit:  $COMMIT_SHA"
echo "    version: $ARTIFACT_VERSION"

make setup:build
make dist:go
cp target/release/libboxlite.a sdks/go/libboxlite.a

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -C apps \
  -ldflags "-X 'github.com/boxlite-ai/daemon/internal.Version=${ARTIFACT_VERSION}'" \
  -o runner/pkg/daemon/static/daemon-amd64 \
  ./daemon/cmd/daemon/

CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -C apps \
  -o runner/pkg/daemon/static/boxlite-computer-use \
  ./libs/computer-use/

CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -C apps \
  -ldflags "-X 'github.com/boxlite-ai/runner/internal.Version=${ARTIFACT_VERSION}'" \
  -o /tmp/boxlite-runner \
  ./runner/cmd/runner/

tar czf "${OUTPUT_DIR}/${ARTIFACT_FILE}" -C /tmp boxlite-runner
rm -f /tmp/boxlite-runner

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM=$(sha256sum "${OUTPUT_DIR}/${ARTIFACT_FILE}" | awk '{print $1}')
else
  CHECKSUM=$(shasum -a 256 "${OUTPUT_DIR}/${ARTIFACT_FILE}" | awk '{print $1}')
fi

cat > "$ENV_FILE" <<EOF
RUNNER_ARTIFACT_VERSION=${ARTIFACT_VERSION}
RUNNER_ARTIFACT_FILE=${OUTPUT_DIR}/${ARTIFACT_FILE}
RUNNER_ARTIFACT_NAME=${ARTIFACT_FILE}
RUNNER_ARTIFACT_SHA256=${CHECKSUM}
RUNNER_COMMIT_SHA=${COMMIT_SHA}
RUNNER_COMMIT_SHORT=${COMMIT_SHORT}
EOF

echo "==> Built ${OUTPUT_DIR}/${ARTIFACT_FILE}"
echo "    sha256: $CHECKSUM"
