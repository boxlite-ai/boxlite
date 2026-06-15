#!/usr/bin/env bash
# Deploy the dev SST stage and optionally roll out a runner artifact.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
DEPLOY_MODE="${DEPLOY_MODE:-diff-only}"
RUNNER_MODE="${RUNNER_MODE:-auto}"
RUNNER_REF="${RUNNER_REF:-}"
CONFIRM="${CONFIRM:-}"
RUNNER_MANIFEST_PREFIX="${RUNNER_MANIFEST_PREFIX:-deployments}"
RUNNER_TEMP_URL_TTL="${RUNNER_TEMP_URL_TTL:-3600}"
RUNNER_MODE_EFFECTIVE="$RUNNER_MODE"

usage() {
  cat <<EOF
Usage: $(basename "$0") --confirm dev [OPTIONS]

Options:
  --deploy-mode MODE     diff-only | deploy (default: diff-only)
  --runner-mode MODE     auto | skip | existing-release | temporary-build | rollback (default: auto)
  --runner-ref REF       Release version for existing-release, e.g. 0.9.5
  --stage STAGE          Only dev is supported by this script today.
  --region REGION        AWS region (default: ap-southeast-1).
  --confirm dev          Required safety confirmation.

Environment:
  STACK_DOMAIN           Required for deploy/verify, e.g. dev.boxlite.ai.
  RUNNER_ARTIFACT_BUCKET Optional. Defaults to boxlite-dev-deploy-artifacts-<account>-<region>.
  ADMIN_API_KEY          Optional. Enables Admin runner overview verification.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-mode)
      DEPLOY_MODE="$2"
      shift 2
      ;;
    --runner-mode)
      RUNNER_MODE="$2"
      shift 2
      ;;
    --runner-ref)
      RUNNER_REF="$2"
      shift 2
      ;;
    --stage)
      STAGE="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --confirm)
      CONFIRM="$2"
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

case "$DEPLOY_MODE" in
  diff-only|deploy) ;;
  *)
    echo "error: unsupported deploy mode: $DEPLOY_MODE" >&2
    exit 2
    ;;
esac

case "$RUNNER_MODE" in
  auto|skip|existing-release|temporary-build|rollback) ;;
  *)
    echo "error: unsupported runner mode: $RUNNER_MODE" >&2
    exit 2
    ;;
esac

if [[ "$STAGE" != "dev" || "$CONFIRM" != "dev" ]]; then
  echo "error: this script currently supports only confirmed dev deploys" >&2
  echo "hint: pass --stage dev --confirm dev" >&2
  exit 1
fi

if [[ "$DEPLOY_MODE" == "diff-only" && "$RUNNER_MODE" != "skip" && "$RUNNER_MODE" != "auto" ]]; then
  echo "error: runner rollout requires --deploy-mode deploy" >&2
  exit 1
fi

if [[ "$RUNNER_MODE" == "existing-release" && -z "$RUNNER_REF" ]]; then
  echo "error: --runner-ref is required for runner_mode=existing-release" >&2
  exit 2
fi

require_cmd aws
require_cmd jq

cd "$REPO_ROOT"

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short=12 HEAD)
BRANCH_NAME=$(git branch --show-current || true)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
RUNNER_ARTIFACT_BUCKET="${RUNNER_ARTIFACT_BUCKET:-boxlite-${STAGE}-deploy-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"

echo "==> Deploy Dev"
echo "    branch:       ${BRANCH_NAME:-detached}"
echo "    commit:       $COMMIT_SHA"
echo "    stage:        $STAGE"
echo "    region:       $AWS_REGION"
echo "    account:      $ACCOUNT_ID"
echo "    stack_domain: ${STACK_DOMAIN:-unset}"
echo "    deploy_mode:  $DEPLOY_MODE"
echo "    runner_mode:  $RUNNER_MODE"

if [[ -z "${STACK_DOMAIN:-}" ]]; then
  echo "error: STACK_DOMAIN is required" >&2
  exit 1
fi

run_sst() {
  require_cmd npm
  (
    cd "$REPO_ROOT/apps/infra"
    if [[ ! -d node_modules ]]; then
      npm ci
    fi
    echo "==> SST diff"
    npx sst diff --stage "$STAGE"
    if [[ "$DEPLOY_MODE" == "deploy" ]]; then
      echo "==> SST deploy"
      npx sst deploy --stage "$STAGE"
    fi
  )
}

verify_api_health() {
  if [[ "$DEPLOY_MODE" != "deploy" ]]; then
    return
  fi

  local health_url="${API_HEALTH_URL:-https://api.${STACK_DOMAIN}/api/health}"
  echo "==> Verifying API health: $health_url"
  curl -fsS "$health_url" >/dev/null

  if [[ -n "${ADMIN_API_KEY:-}" ]]; then
    local runners_url="${API_RUNNERS_URL:-https://api.${STACK_DOMAIN}/api/admin/overview/runners}"
    echo "==> Verifying Admin runner overview"
    curl -fsS -H "authorization: Bearer ${ADMIN_API_KEY}" "$runners_url" | jq 'length' >/dev/null
  else
    echo "==> ADMIN_API_KEY not set; skipping Admin runner overview verification"
  fi
}

ensure_artifact_bucket() {
  echo "==> Checking runner artifact bucket: $RUNNER_ARTIFACT_BUCKET"
  aws s3api head-bucket --bucket "$RUNNER_ARTIFACT_BUCKET" --region "$AWS_REGION" >/dev/null
}

app_manifest_key_current() {
  printf '%s/%s/app/current.json' "$RUNNER_MANIFEST_PREFIX" "$STAGE"
}

app_manifest_key_history() {
  local deployed_at="$1"
  printf '%s/%s/app/history/%s.json' "$RUNNER_MANIFEST_PREFIX" "$STAGE" "$deployed_at"
}

preflight_runner_auto() {
  if [[ "$DEPLOY_MODE" != "deploy" || "$RUNNER_MODE" != "auto" ]]; then
    return
  fi

  echo "==> Checking runner changes for auto mode"

  local output status
  set +e
  output=$("$REPO_ROOT/scripts/deploy/runner-change-check.sh" \
    --stage "$STAGE" \
    --region "$AWS_REGION" \
    --manifest-bucket "$RUNNER_ARTIFACT_BUCKET" \
    --manifest-prefix "$RUNNER_MANIFEST_PREFIX" \
    --head "$COMMIT_SHA")
  status=$?
  set -e

  echo "$output"

  case "$status" in
    0)
      echo "==> Runner auto decision: inputs unchanged; runner rollout will be skipped"
      RUNNER_MODE_EFFECTIVE="skip"
      ;;
    10)
      echo "error: runner inputs changed since the last recorded dev app deploy" >&2
      echo "hint: rerun with --runner-mode temporary-build for dev validation, or --runner-mode existing-release --runner-ref <version> for a release artifact" >&2
      exit 1
      ;;
    11)
      echo "error: runner auto mode cannot find a usable prior dev app deploy manifest" >&2
      echo "hint: for the first run, choose --runner-mode skip if runner should not change, or choose temporary-build/existing-release explicitly" >&2
      exit 1
      ;;
    *)
      echo "error: runner auto check failed with status $status" >&2
      exit "$status"
      ;;
  esac
}

write_app_manifest() {
  if [[ "$DEPLOY_MODE" != "deploy" ]]; then
    return
  fi

  local deployed_at current_key history_key current_json previous_json manifest_file
  deployed_at=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  current_key=$(app_manifest_key_current)
  history_key=$(app_manifest_key_history "$deployed_at")
  current_json=$(aws s3 cp "s3://${RUNNER_ARTIFACT_BUCKET}/${current_key}" - --region "$AWS_REGION" 2>/dev/null || true)
  if [[ -n "$current_json" ]]; then
    previous_json=$(jq -c 'del(.previous)' <<<"$current_json")
  else
    previous_json="null"
  fi

  manifest_file=$(mktemp)
  jq -n \
    --arg schemaVersion "1" \
    --arg stage "$STAGE" \
    --arg region "$AWS_REGION" \
    --arg deployedAt "$deployed_at" \
    --arg branch "${BRANCH_NAME:-detached}" \
    --arg commitSha "$COMMIT_SHA" \
    --arg commitShort "$COMMIT_SHORT" \
    --arg deployMode "$DEPLOY_MODE" \
    --arg runnerMode "$RUNNER_MODE" \
    --arg runnerModeEffective "$RUNNER_MODE_EFFECTIVE" \
    --arg runnerRef "$RUNNER_REF" \
    --argjson previous "$previous_json" \
    '{
      schemaVersion: ($schemaVersion | tonumber),
      stage: $stage,
      region: $region,
      deployedAt: $deployedAt,
      branch: $branch,
      commit: {
        sha: $commitSha,
        short: $commitShort
      },
      deployMode: $deployMode,
      runnerMode: $runnerMode,
      runnerModeEffective: $runnerModeEffective,
      runnerRef: (if $runnerRef == "" then null else $runnerRef end),
      previous: $previous
    }' > "$manifest_file"

  aws s3 cp "$manifest_file" "s3://${RUNNER_ARTIFACT_BUCKET}/${current_key}" --region "$AWS_REGION" >/dev/null
  aws s3 cp "$manifest_file" "s3://${RUNNER_ARTIFACT_BUCKET}/${history_key}" --region "$AWS_REGION" >/dev/null
  rm -f "$manifest_file"

  echo "==> Wrote app deploy manifest"
  echo "    current: s3://${RUNNER_ARTIFACT_BUCKET}/${current_key}"
  echo "    history: s3://${RUNNER_ARTIFACT_BUCKET}/${history_key}"
}

rollout_existing_release() {
  require_cmd gh
  local version="${RUNNER_REF#v}"
  local release_tag="v${version}"
  local asset_name="boxlite-runner-v${version}-linux-amd64.tar.gz"

  echo "==> Checking runner release asset: ${release_tag}/${asset_name}"
  gh release view "$release_tag" --json assets \
    --jq ".assets[].name" | grep -Fx "$asset_name" >/dev/null

  local url="https://github.com/boxlite-ai/boxlite/releases/download/${release_tag}/${asset_name}"
  "$REPO_ROOT/scripts/deploy/runner-rollout.sh" \
    --stage "$STAGE" \
    --mode existing-release \
    --artifact-url "$url" \
    --artifact-version "$version" \
    --source-kind github-release \
    --source-ref "$release_tag" \
    --manifest-bucket "$RUNNER_ARTIFACT_BUCKET" \
    --manifest-prefix "$RUNNER_MANIFEST_PREFIX"
}

rollout_temporary_build() {
  ensure_artifact_bucket

  "$REPO_ROOT/scripts/deploy/runner-build-temp.sh" --output-dir "$REPO_ROOT/dist/deploy"
  # shellcheck disable=SC1091
  source "$REPO_ROOT/dist/deploy/runner-artifact.env"

  local s3_key="runner-temp/${RUNNER_COMMIT_SHA}/${RUNNER_ARTIFACT_NAME}"
  local s3_uri="s3://${RUNNER_ARTIFACT_BUCKET}/${s3_key}"

  echo "==> Uploading temporary runner artifact"
  echo "    $s3_uri"
  aws s3 cp "$RUNNER_ARTIFACT_FILE" "$s3_uri" \
    --region "$AWS_REGION" \
    --metadata "commit=${RUNNER_COMMIT_SHA},sha256=${RUNNER_ARTIFACT_SHA256},version=${RUNNER_ARTIFACT_VERSION}" \
    >/dev/null

  local presigned_url
  presigned_url=$(aws s3 presign "$s3_uri" --region "$AWS_REGION" --expires-in "$RUNNER_TEMP_URL_TTL")

  "$REPO_ROOT/scripts/deploy/runner-rollout.sh" \
    --stage "$STAGE" \
    --mode temporary-build \
    --artifact-url "$presigned_url" \
    --artifact-version "$RUNNER_ARTIFACT_VERSION" \
    --source-kind s3 \
    --source-ref "$s3_uri" \
    --source-bucket "$RUNNER_ARTIFACT_BUCKET" \
    --source-key "$s3_key" \
    --manifest-bucket "$RUNNER_ARTIFACT_BUCKET" \
    --manifest-prefix "$RUNNER_MANIFEST_PREFIX"
}

rollout_rollback() {
  ensure_artifact_bucket
  "$REPO_ROOT/scripts/deploy/runner-rollout.sh" \
    --stage "$STAGE" \
    --mode rollback \
    --manifest-bucket "$RUNNER_ARTIFACT_BUCKET" \
    --manifest-prefix "$RUNNER_MANIFEST_PREFIX"
}

if [[ "$RUNNER_MODE" == "auto" ]]; then
  RUNNER_MODE_EFFECTIVE="skip"
fi

preflight_runner_auto
run_sst

case "$RUNNER_MODE_EFFECTIVE" in
  skip)
    echo "==> Runner rollout skipped"
    ;;
  existing-release)
    rollout_existing_release
    ;;
  temporary-build)
    rollout_temporary_build
    ;;
  rollback)
    rollout_rollback
    ;;
esac

verify_api_health
write_app_manifest

echo "==> Deploy Dev complete"
echo "    commit:      $COMMIT_SHORT"
echo "    stage:       $STAGE"
echo "    runner_mode: $RUNNER_MODE"
