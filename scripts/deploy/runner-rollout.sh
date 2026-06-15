#!/usr/bin/env bash
# Roll out a runner artifact to all runner EC2 instances in one SST stage.
#
# Supported sources:
#   - existing GitHub Release URL
#   - temporary S3 artifact via presigned URL
#   - rollback to the previous manifest entry

set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
STAGE="${STAGE:-dev}"
MODE=""
ARTIFACT_URL=""
ARTIFACT_VERSION=""
SOURCE_KIND=""
SOURCE_REF=""
SOURCE_BUCKET=""
SOURCE_KEY=""
MANIFEST_BUCKET=""
MANIFEST_PREFIX="${RUNNER_MANIFEST_PREFIX:-deployments}"
APP_TAG="${RUNNER_APP_TAG:-boxlite}"
COMMAND_TIMEOUT_SECONDS="${RUNNER_SSM_TIMEOUT_SECONDS:-900}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --stage dev --mode MODE [OPTIONS]

Modes:
  existing-release   Install a GitHub Release runner artifact.
  temporary-build    Install a temporary artifact from a presigned URL.
  rollback           Install the previous artifact recorded in S3 manifest.

Options:
  --artifact-url URL       Presigned or public runner tarball URL.
  --artifact-version VER   Version label expected after install.
  --source-kind KIND       github-release | s3
  --source-ref REF         Human-readable source ref, e.g. v0.9.5 or s3://...
  --source-bucket BUCKET   S3 bucket for temporary source.
  --source-key KEY         S3 key for temporary source.
  --manifest-bucket BUCKET Bucket storing runner rollout manifests.
  --manifest-prefix PREFIX Manifest prefix (default: deployments).

Environment:
  AWS_REGION               AWS region (default: ap-southeast-1).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --artifact-url)
      ARTIFACT_URL="$2"
      shift 2
      ;;
    --artifact-version)
      ARTIFACT_VERSION="$2"
      shift 2
      ;;
    --source-kind)
      SOURCE_KIND="$2"
      shift 2
      ;;
    --source-ref)
      SOURCE_REF="$2"
      shift 2
      ;;
    --source-bucket)
      SOURCE_BUCKET="$2"
      shift 2
      ;;
    --source-key)
      SOURCE_KEY="$2"
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

require_cmd aws
require_cmd jq

if [[ "$STAGE" != "dev" ]]; then
  echo "error: runner-rollout currently supports only stage=dev" >&2
  exit 1
fi

if [[ -z "$MODE" ]]; then
  echo "error: --mode is required" >&2
  usage >&2
  exit 2
fi

manifest_key_current() {
  printf '%s/%s/runner/current.json' "$MANIFEST_PREFIX" "$STAGE"
}

manifest_key_history() {
  local deployed_at="$1"
  printf '%s/%s/runner/history/%s.json' "$MANIFEST_PREFIX" "$STAGE" "$deployed_at"
}

load_previous_manifest_source() {
  if [[ -z "$MANIFEST_BUCKET" ]]; then
    echo "error: rollback requires --manifest-bucket" >&2
    exit 1
  fi

  local current_json
  current_json=$(aws s3 cp "s3://${MANIFEST_BUCKET}/$(manifest_key_current)" - --region "$AWS_REGION" 2>/dev/null || true)
  if [[ -z "$current_json" ]]; then
    echo "error: no current runner manifest found for rollback" >&2
    exit 1
  fi

  local previous_json
  previous_json=$(jq -c '.previous // empty' <<<"$current_json")
  if [[ -z "$previous_json" || "$previous_json" == "null" ]]; then
    echo "error: current manifest has no previous rollout to rollback to" >&2
    exit 1
  fi

  SOURCE_KIND=$(jq -r '.source.kind' <<<"$previous_json")
  SOURCE_REF=$(jq -r '.source.ref' <<<"$previous_json")
  ARTIFACT_VERSION=$(jq -r '.artifact.version' <<<"$previous_json")
  SOURCE_BUCKET=$(jq -r '.source.bucket // empty' <<<"$previous_json")
  SOURCE_KEY=$(jq -r '.source.key // empty' <<<"$previous_json")

  case "$SOURCE_KIND" in
    github-release)
      local version_no_v="${ARTIFACT_VERSION#v}"
      ARTIFACT_URL="https://github.com/boxlite-ai/boxlite/releases/download/v${version_no_v}/boxlite-runner-v${version_no_v}-linux-amd64.tar.gz"
      ;;
    s3)
      if [[ -z "$SOURCE_BUCKET" || -z "$SOURCE_KEY" ]]; then
        echo "error: previous S3 source is missing bucket/key" >&2
        exit 1
      fi
      ARTIFACT_URL=$(aws s3 presign "s3://${SOURCE_BUCKET}/${SOURCE_KEY}" --region "$AWS_REGION" --expires-in 3600)
      ;;
    *)
      echo "error: unsupported previous source kind: $SOURCE_KIND" >&2
      exit 1
      ;;
  esac
}

if [[ "$MODE" == "rollback" ]]; then
  load_previous_manifest_source
elif [[ -z "$ARTIFACT_URL" || -z "$ARTIFACT_VERSION" || -z "$SOURCE_KIND" || -z "$SOURCE_REF" ]]; then
  echo "error: --artifact-url, --artifact-version, --source-kind, and --source-ref are required for $MODE" >&2
  exit 2
fi

case "$MODE" in
  existing-release|temporary-build|rollback) ;;
  *)
    echo "error: unsupported mode: $MODE" >&2
    exit 2
    ;;
esac

echo "==> Discovering runner EC2 instances"
echo "    stage:  $STAGE"
echo "    region: $AWS_REGION"

INSTANCES_JSON=$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters \
    "Name=tag:App,Values=${APP_TAG}" \
    "Name=tag:Stage,Values=${STAGE}" \
    "Name=tag:Role,Values=runner" \
    "Name=instance-state-name,Values=running" \
  --output json)

mapfile -t INSTANCE_ROWS < <(
  jq -r '
    [.Reservations[].Instances[]? |
      {
        id: .InstanceId,
        privateIp: (.PrivateIpAddress // ""),
        name: (((.Tags // []) | map(select(.Key == "Name") | .Value) | first) // "")
      }
    ] | sort_by(.name)[] | [.id, .name, .privateIp] | @tsv
  ' <<<"$INSTANCES_JSON"
)

if [[ ${#INSTANCE_ROWS[@]} -eq 0 ]]; then
  echo "error: no running runner instances found with tags App=${APP_TAG},Stage=${STAGE},Role=runner" >&2
  echo "hint: run sst deploy first so runner EC2 tags are updated" >&2
  exit 1
fi

echo "==> Rolling out runner artifact"
echo "    mode:     $MODE"
echo "    source:   $SOURCE_REF"
echo "    version:  $ARTIFACT_VERSION"
echo "    runners:  ${#INSTANCE_ROWS[@]}"

RESULTS_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE"' EXIT

rollout_one() {
  local instance_id="$1"
  local instance_name="$2"
  local private_ip="$3"

  echo "==> Updating $instance_name ($instance_id $private_ip)"

  local remote_script
  read -r -d '' remote_script <<REMOTE || true
set -euo pipefail
tmp=\$(mktemp -d)
cleanup() { rm -rf "\$tmp"; }
trap cleanup EXIT

current=""
if [ -x /usr/local/bin/boxlite-runner ]; then
  current=\$(/usr/local/bin/boxlite-runner --version 2>/dev/null || true)
fi
echo "BOXLITE_RUNNER_OLD_VERSION=\${current}"

mkdir -p /opt/boxlite/runner-releases
if [ -x /usr/local/bin/boxlite-runner ]; then
  cp -f /usr/local/bin/boxlite-runner "/opt/boxlite/runner-releases/boxlite-runner.\$(date -u +%Y%m%dT%H%M%SZ).bak"
fi

curl -fsSL "${ARTIFACT_URL}" -o "\$tmp/runner.tar.gz"
tar xzf "\$tmp/runner.tar.gz" -C "\$tmp"
test -f "\$tmp/boxlite-runner"

systemctl stop boxlite-runner
install -m 0755 "\$tmp/boxlite-runner" /usr/local/bin/boxlite-runner
systemctl start boxlite-runner

sleep 3
new=\$(/usr/local/bin/boxlite-runner --version)
echo "BOXLITE_RUNNER_NEW_VERSION=\${new}"
systemctl is-active --quiet boxlite-runner
echo "BOXLITE_RUNNER_SYSTEMD=active"
REMOTE

  local params_file
  params_file=$(mktemp)
  jq -n --arg script "$remote_script" '{commands: [$script]}' > "$params_file"

  local cmd_id
  cmd_id=$(aws ssm send-command --region "$AWS_REGION" \
    --document-name "AWS-RunShellScript" \
    --instance-ids "$instance_id" \
    --comment "boxlite runner ${MODE} ${ARTIFACT_VERSION}" \
    --timeout-seconds "$COMMAND_TIMEOUT_SECONDS" \
    --parameters "file://${params_file}" \
    --query 'Command.CommandId' --output text)
  rm -f "$params_file"

  aws ssm wait command-executed --region "$AWS_REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" || true

  local status stdout stderr old_version new_version
  status=$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" \
    --query 'Status' --output text)
  stdout=$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" \
    --query 'StandardOutputContent' --output text)
  stderr=$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" \
    --query 'StandardErrorContent' --output text)

  echo "$stdout"
  if [[ "$status" != "Success" ]]; then
    echo "$stderr" >&2
    echo "error: SSM command failed for $instance_name ($instance_id): $status" >&2
    exit 1
  fi

  old_version=$(grep -m1 '^BOXLITE_RUNNER_OLD_VERSION=' <<<"$stdout" | cut -d= -f2- || true)
  new_version=$(grep -m1 '^BOXLITE_RUNNER_NEW_VERSION=' <<<"$stdout" | cut -d= -f2- || true)

  jq -nc \
    --arg id "$instance_id" \
    --arg name "$instance_name" \
    --arg privateIp "$private_ip" \
    --arg commandId "$cmd_id" \
    --arg oldVersion "$old_version" \
    --arg newVersion "$new_version" \
    '{instanceId:$id,name:$name,privateIp:$privateIp,commandId:$commandId,oldVersion:$oldVersion,newVersion:$newVersion,status:"Success"}' \
    >> "$RESULTS_FILE"
}

for row in "${INSTANCE_ROWS[@]}"; do
  IFS=$'\t' read -r instance_id instance_name private_ip <<<"$row"
  rollout_one "$instance_id" "$instance_name" "$private_ip"
done

RUNNERS_JSON=$(jq -s '.' "$RESULTS_FILE")

write_manifest() {
  if [[ -z "$MANIFEST_BUCKET" ]]; then
    echo "==> Manifest bucket not set; skipping manifest write"
    return
  fi

  local deployed_at current_json previous_json manifest_file history_key current_key
  deployed_at=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  current_key=$(manifest_key_current)
  history_key=$(manifest_key_history "$deployed_at")
  current_json=$(aws s3 cp "s3://${MANIFEST_BUCKET}/${current_key}" - --region "$AWS_REGION" 2>/dev/null || true)
  if [[ -n "$current_json" ]]; then
    previous_json=$(jq -c 'del(.previous)' <<<"$current_json")
  else
    previous_json="null"
  fi

  manifest_file=$(mktemp)
  jq -n \
    --arg schemaVersion "1" \
    --arg stage "$STAGE" \
    --arg mode "$MODE" \
    --arg deployedAt "$deployed_at" \
    --arg region "$AWS_REGION" \
    --arg version "$ARTIFACT_VERSION" \
    --arg sourceKind "$SOURCE_KIND" \
    --arg sourceRef "$SOURCE_REF" \
    --arg sourceBucket "$SOURCE_BUCKET" \
    --arg sourceKey "$SOURCE_KEY" \
    --argjson runners "$RUNNERS_JSON" \
    --argjson previous "$previous_json" \
    '{
      schemaVersion: ($schemaVersion | tonumber),
      stage: $stage,
      mode: $mode,
      deployedAt: $deployedAt,
      region: $region,
      artifact: { version: $version },
      source: {
        kind: $sourceKind,
        ref: $sourceRef,
        bucket: (if $sourceBucket == "" then null else $sourceBucket end),
        key: (if $sourceKey == "" then null else $sourceKey end)
      },
      runners: $runners,
      previous: $previous
    }' > "$manifest_file"

  aws s3 cp "$manifest_file" "s3://${MANIFEST_BUCKET}/${current_key}" --region "$AWS_REGION" >/dev/null
  aws s3 cp "$manifest_file" "s3://${MANIFEST_BUCKET}/${history_key}" --region "$AWS_REGION" >/dev/null
  rm -f "$manifest_file"

  echo "==> Wrote runner manifest"
  echo "    current: s3://${MANIFEST_BUCKET}/${current_key}"
  echo "    history: s3://${MANIFEST_BUCKET}/${history_key}"
}

write_manifest

echo "==> Runner rollout complete"
jq -r '.[] | "- \(.name) \(.instanceId): \(.oldVersion) -> \(.newVersion)"' <<<"$RUNNERS_JSON"
