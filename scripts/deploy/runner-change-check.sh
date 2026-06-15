#!/usr/bin/env bash
# Compare the selected commit with the last recorded dev app deploy and report
# whether runner build inputs changed.

set -euo pipefail

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
MANIFEST_BUCKET="${RUNNER_ARTIFACT_BUCKET:-}"
MANIFEST_PREFIX="${RUNNER_MANIFEST_PREFIX:-deployments}"
HEAD_REF="${HEAD_REF:-HEAD}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --stage dev --manifest-bucket BUCKET [OPTIONS]

Options:
  --stage STAGE              Only dev is supported today.
  --region REGION            AWS region (default: ap-southeast-1).
  --manifest-bucket BUCKET   Bucket storing deploy manifests.
  --manifest-prefix PREFIX   Manifest prefix (default: deployments).
  --head REF                 Ref to compare (default: HEAD).

Exit codes:
  0   Runner inputs unchanged.
  10  Runner inputs changed.
  11  No usable prior app deploy manifest.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --manifest-bucket)
      MANIFEST_BUCKET="$2"
      shift 2
      ;;
    --manifest-prefix)
      MANIFEST_PREFIX="$2"
      shift 2
      ;;
    --head)
      HEAD_REF="$2"
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

if [[ "$STAGE" != "dev" ]]; then
  echo "error: runner auto-check currently supports only dev" >&2
  exit 2
fi

if [[ -z "$MANIFEST_BUCKET" ]]; then
  echo "runner_auto_status=unknown"
  echo "runner_auto_reason=missing_manifest_bucket"
  exit 11
fi

for cmd in aws git jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 2
  fi
done

manifest_key="${MANIFEST_PREFIX}/${STAGE}/app/current.json"
current_json=$(aws s3 cp "s3://${MANIFEST_BUCKET}/${manifest_key}" - --region "$AWS_REGION" 2>/dev/null || true)

if [[ -z "$current_json" ]]; then
  echo "runner_auto_status=unknown"
  echo "runner_auto_reason=missing_app_manifest"
  echo "runner_auto_manifest=s3://${MANIFEST_BUCKET}/${manifest_key}"
  exit 11
fi

base_ref=$(jq -r '.commit.sha // empty' <<<"$current_json")
if [[ -z "$base_ref" || "$base_ref" == "null" ]]; then
  echo "runner_auto_status=unknown"
  echo "runner_auto_reason=manifest_missing_commit"
  echo "runner_auto_manifest=s3://${MANIFEST_BUCKET}/${manifest_key}"
  exit 11
fi

head_sha=$(git rev-parse "$HEAD_REF")

if ! git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$base_ref" >/dev/null 2>&1 || true
fi

if ! git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  echo "runner_auto_status=unknown"
  echo "runner_auto_reason=baseline_commit_unavailable"
  echo "runner_auto_base=$base_ref"
  exit 11
fi

if [[ "$base_ref" == "$head_sha" ]]; then
  echo "runner_auto_status=unchanged"
  echo "runner_auto_base=$base_ref"
  echo "runner_auto_head=$head_sha"
  exit 0
fi

runner_paths=(
  "apps/runner/**"
  "apps/daemon/**"
  "libs/computer-use/**"
  "sdks/go/**"
  "sdks/c/**"
  "src/boxlite/**"
  "src/shared/**"
  "src/deps/**"
  "Cargo.toml"
  "Cargo.lock"
  "Makefile"
  "go.work"
  "go.work.sum"
)

changed_files=$(git diff --name-only "$base_ref" "$head_sha" -- "${runner_paths[@]}")

echo "runner_auto_base=$base_ref"
echo "runner_auto_head=$head_sha"

if [[ -z "$changed_files" ]]; then
  echo "runner_auto_status=unchanged"
  exit 0
fi

echo "runner_auto_status=changed"
echo "runner_auto_files<<EOF"
echo "$changed_files"
echo "EOF"
exit 10
