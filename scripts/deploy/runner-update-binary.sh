#!/usr/bin/env bash
# Upgrade the boxlite-runner binary on the live Runner EC2 in-place.
#
# Installs the new binary into a versioned release directory, points
# /usr/local/bin/boxlite-runner at it, restarts the systemd unit, and verifies
# that detached box shims that were alive before the restart are still alive and
# can be re-attached by the new runner. The EC2 instance itself is not replaced;
# box state under /var/lib/boxlite is preserved. It uploads the locally built
# runner tarball to a temporary S3 location, then asks SSM to install it on the
# target runner.
#
# Pair with the `ignoreChanges: ["ami", "userDataBase64"]` setting on the
# Runner resource in apps/infra/sst.config.ts — that prevents `sst deploy`
# from recreating the instance on Cargo.toml version bumps; this script is
# how the new version actually lands on the running instance.
#
# Usage:
#   scripts/deploy/runner-update-binary.sh                  # version from Cargo.toml
#   scripts/deploy/runner-update-binary.sh 0.9.7-dev-123-58d8f01bcd02
#   scripts/deploy/runner-update-binary.sh --output-dir /tmp/dist 0.9.7-dev-123-58d8f01bcd02
#   AWS_REGION=us-west-2 scripts/deploy/runner-update-binary.sh
#   STAGE=production scripts/deploy/runner-update-binary.sh
#   RUNNER_INSTANCE_ID=i-0123456789abcdef0 scripts/deploy/runner-update-binary.sh
#   PROD_RUNNER_INSTANCE_ID=i-0123456789abcdef0 STAGE=production scripts/deploy/runner-update-binary.sh

set -euo pipefail

STAGE="${STAGE:-dev}"
DEV_AWS_REGION="${DEV_AWS_REGION:-ap-southeast-1}"
DEV_RUNNER_INSTANCE_NAME="${DEV_RUNNER_INSTANCE_NAME:-boxlite-dev-runner-default}"
DEV_RUNNER_INSTANCE_ID="${DEV_RUNNER_INSTANCE_ID:-}"
PROD_AWS_REGION="${PROD_AWS_REGION:-us-west-2}"
PROD_RUNNER_INSTANCE_NAME="${PROD_RUNNER_INSTANCE_NAME:-boxlite-prod-runner-default}"
PROD_RUNNER_INSTANCE_ID="${PROD_RUNNER_INSTANCE_ID:-}"
AWS_REGION="${AWS_REGION:-}"
RUNNER_INSTANCE_NAME="${RUNNER_INSTANCE_NAME:-}"
RUNNER_INSTANCE_ID="${RUNNER_INSTANCE_ID:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${RUNNER_ARTIFACT_DIR:-$REPO_ROOT/dist}"
RUNNER_ARTIFACT_S3_URI="${RUNNER_ARTIFACT_S3_URI:-}"
VERSION=""

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir|--artifact-dir)
      [[ $# -ge 2 ]] || { echo "error: $1 requires a value" >&2; exit 1; }
      ARTIFACT_DIR="$2"
      shift 2
      ;;
    --version)
      [[ $# -ge 2 ]] || { echo "error: --version requires a value" >&2; exit 1; }
      VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "error: unexpected extra argument $1" >&2
        usage >&2
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "error: required command not found: aws" >&2; exit 1; }

case "$STAGE" in
  dev|production) ;;
  prod) STAGE="production" ;;
  *)
    echo "error: STAGE must be dev or production (got: $STAGE)" >&2
    exit 1
    ;;
esac

case "$STAGE" in
  dev)
    AWS_REGION="${AWS_REGION:-$DEV_AWS_REGION}"
    RUNNER_INSTANCE_ID="${RUNNER_INSTANCE_ID:-$DEV_RUNNER_INSTANCE_ID}"
    RUNNER_INSTANCE_NAME="${RUNNER_INSTANCE_NAME:-$DEV_RUNNER_INSTANCE_NAME}"
    ;;
  production)
    AWS_REGION="${AWS_REGION:-$PROD_AWS_REGION}"
    RUNNER_INSTANCE_ID="${RUNNER_INSTANCE_ID:-$PROD_RUNNER_INSTANCE_ID}"
    RUNNER_INSTANCE_NAME="${RUNNER_INSTANCE_NAME:-$PROD_RUNNER_INSTANCE_NAME}"
    ;;
esac

if [[ -z "$VERSION" ]]; then
  VERSION=$(grep -m 1 '^version' "$REPO_ROOT/Cargo.toml" | sed -E 's/^version *= *"([^"]+)".*/\1/')
  if [[ -z "$VERSION" ]]; then
    echo "error: could not read version from Cargo.toml at $REPO_ROOT/Cargo.toml" >&2
    exit 1
  fi
fi

ASSET_TARBALL="boxlite-runner-v${VERSION}-linux-amd64.tar.gz"
LOCAL_TARBALL="$ARTIFACT_DIR/$ASSET_TARBALL"
LOCAL_SHA="$LOCAL_TARBALL.sha256"
RUNTIME_CACHE_VERSION="${VERSION%%-dev-*}"

if [[ ! -f "$LOCAL_TARBALL" ]]; then
  echo "error: local runner tarball not found: $LOCAL_TARBALL" >&2
  echo "       run scripts/deploy/build-runner-binary.sh first, or set --output-dir/RUNNER_ARTIFACT_DIR" >&2
  exit 1
fi
if [[ ! -f "$LOCAL_SHA" ]]; then
  echo "error: local runner checksum not found: $LOCAL_SHA" >&2
  echo "       run scripts/deploy/build-runner-binary.sh first" >&2
  exit 1
fi

echo "==> Upgrading boxlite-runner from local artifact v$VERSION on stage=$STAGE region=$AWS_REGION"

if [[ -n "$RUNNER_INSTANCE_ID" ]]; then
  INSTANCE_ID="$RUNNER_INSTANCE_ID"
else
  INSTANCE_FILTERS=(
    "Name=tag:Name,Values=${RUNNER_INSTANCE_NAME}"
    "Name=instance-state-name,Values=running"
  )
  INSTANCE_IDS=()
  while IFS= read -r instance_id; do
    INSTANCE_IDS+=("$instance_id")
  done < <(aws ec2 describe-instances --region "$AWS_REGION" \
    --filters "${INSTANCE_FILTERS[@]}" \
    --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | sed '/^$/d')

  if [[ "${#INSTANCE_IDS[@]}" -ne 1 ]]; then
    echo "error: expected exactly one running runner instance, found ${#INSTANCE_IDS[@]}" >&2
    echo "       region=$AWS_REGION stage=$STAGE name=$RUNNER_INSTANCE_NAME" >&2
    if [[ "${#INSTANCE_IDS[@]}" -gt 0 ]]; then
      printf '       matches: %s\n' "${INSTANCE_IDS[*]}" >&2
    fi
    echo "       set RUNNER_INSTANCE_ID=i-... to target an instance explicitly" >&2
    exit 1
  fi
  INSTANCE_ID="${INSTANCE_IDS[0]}"
fi
echo "    instance: $INSTANCE_ID"

if [[ -z "$RUNNER_ARTIFACT_S3_URI" ]]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  RUNNER_ARTIFACT_S3_URI="s3://boxlite-${STAGE}-runner-builds/tmp/runner-rollouts/${ACCOUNT_ID}/${VERSION}/$(date -u +%Y%m%dT%H%M%SZ)"
fi
REMOTE_TARBALL_URL="${RUNNER_ARTIFACT_S3_URI%/}/$ASSET_TARBALL"
REMOTE_SHA_URL="$REMOTE_TARBALL_URL.sha256"
echo "==> Uploading local artifact to $RUNNER_ARTIFACT_S3_URI"
aws s3 cp --region "$AWS_REGION" "$LOCAL_TARBALL" "$REMOTE_TARBALL_URL"
aws s3 cp --region "$AWS_REGION" "$LOCAL_SHA" "$REMOTE_SHA_URL"
PRESIGNED_TARBALL_URL=$(aws s3 presign --region "$AWS_REGION" "$REMOTE_TARBALL_URL" --expires-in 3600)
PRESIGNED_SHA_URL=$(aws s3 presign --region "$AWS_REGION" "$REMOTE_SHA_URL" --expires-in 3600)

# Remote upgrade script. Mirrors the boot user-data's integrity policy and adds a
# rollback: download + checksum-verify BEFORE stopping the unit (so a failed or
# corrupt fetch never takes the runner down), install the new binary into a
# versioned release directory, switch the live symlink, and switch back if the
# new binary fails to come up.
read -r -d '' SCRIPT <<EOF || true
set -euo pipefail
SERVICE=boxlite-runner
RUNNER_BIN=/usr/local/bin/boxlite-runner
RELEASES_DIR=/usr/local/lib/boxlite-runner/releases
KEEP_RELEASES=\${RUNNER_KEEP_RELEASES:-5}
HOT_SNAPSHOT=\$(mktemp)

load_runner_env() {
  API_PORT=8080
  BOXLITE_HOME_DIR=/var/lib/boxlite
  BOXLITE_RUNNER_TOKEN=
  ENABLE_TLS=false
  while IFS= read -r kv; do
    case "\$kv" in
      API_PORT=*) API_PORT="\${kv#API_PORT=}" ;;
      BOXLITE_HOME_DIR=*) BOXLITE_HOME_DIR="\${kv#BOXLITE_HOME_DIR=}" ;;
      BOXLITE_RUNNER_TOKEN=*) BOXLITE_RUNNER_TOKEN="\${kv#BOXLITE_RUNNER_TOKEN=}" ;;
      API_TOKEN=*) [ -n "\$BOXLITE_RUNNER_TOKEN" ] || BOXLITE_RUNNER_TOKEN="\${kv#API_TOKEN=}" ;;
      ENABLE_TLS=*) ENABLE_TLS="\${kv#ENABLE_TLS=}" ;;
    esac
  done < <(systemctl show "\$SERVICE" --property=Environment --value | tr ' ' '\n')
  if [ -z "\$BOXLITE_RUNNER_TOKEN" ]; then
    echo "FATAL: could not read BOXLITE_RUNNER_TOKEN/API_TOKEN from \$SERVICE environment" >&2
    exit 1
  fi
  if [ "\$ENABLE_TLS" = true ]; then
    RUNNER_BASE_URL="https://127.0.0.1:\$API_PORT"
    CURL_TLS=(-k)
  else
    RUNNER_BASE_URL="http://127.0.0.1:\$API_PORT"
    CURL_TLS=()
  fi
}

proc_start_time() {
  awk '{print \$22}' "/proc/\$1/stat" 2>/dev/null || true
}

proc_state() {
  awk '{print \$3}' "/proc/\$1/stat" 2>/dev/null || true
}

pid_alive() {
  local pid="\$1"
  [ -n "\$pid" ] || return 1
  kill -0 "\$pid" 2>/dev/null || return 1
  [ "\$(proc_state "\$pid")" != Z ]
}

snapshot_live_detached_shims() {
  : > "\$HOT_SNAPSHOT"
  local boxes_dir="\$BOXLITE_HOME_DIR/boxes"
  [ -d "\$boxes_dir" ] || return 0
  while IFS= read -r pid_file; do
    local box_id pid start actual_start
    box_id="\$(basename "\$(dirname "\$pid_file")")"
    pid="\$(sed -n '1p' "\$pid_file" 2>/dev/null | tr -dc '0-9')"
    start="\$(sed -n '2p' "\$pid_file" 2>/dev/null | tr -dc '0-9')"
    pid_alive "\$pid" || continue
    if [ -n "\$start" ]; then
      actual_start="\$(proc_start_time "\$pid")"
      [ "\$actual_start" = "\$start" ] || continue
    fi
    printf '%s %s %s\n' "\$box_id" "\$pid" "\$start" >> "\$HOT_SNAPSHOT"
  done < <(find "\$boxes_dir" -mindepth 2 -maxdepth 2 -name shim.pid -type f 2>/dev/null | sort)
}

wait_runner_ready() {
  local i
  for i in \$(seq 1 30); do
    if curl -fsS "\${CURL_TLS[@]}" "\$RUNNER_BASE_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FATAL: runner API did not become ready at \$RUNNER_BASE_URL" >&2
  return 1
}

verify_runner_health_samples() {
  local i
  for i in 1 2; do
    curl -fsS "\${CURL_TLS[@]}" \
      -H "Authorization: Bearer \$BOXLITE_RUNNER_TOKEN" \
      "\$RUNNER_BASE_URL/info" >/dev/null || {
        echo "FATAL: runner health sample \$i failed at \$RUNNER_BASE_URL/info" >&2
        return 1
      }
    echo "runner health sample \$i: ok"
    [ "\$i" -eq 2 ] || sleep 2
  done
}

runtime_cache_dirs() {
  local version_dir="\${RUNTIME_CACHE_DIR_NAME:-v${RUNTIME_CACHE_VERSION}}"
  local -a data_roots=()
  local svc_user svc_home env_value

  svc_user=\$(systemctl show "\$SERVICE" --property=User --value 2>/dev/null || true)
  if [ -z "\$svc_user" ]; then
    svc_user=root
  fi

  svc_home=\$(getent passwd "\$svc_user" 2>/dev/null | cut -d: -f6 || true)
  [ -n "\$svc_home" ] && data_roots+=("\$svc_home/.local/share")

  while IFS= read -r env_value; do
    case "\$env_value" in
      XDG_DATA_HOME=*) data_roots+=("\${env_value#XDG_DATA_HOME=}") ;;
      HOME=*) data_roots+=("\${env_value#HOME=}/.local/share") ;;
    esac
  done < <(systemctl show "\$SERVICE" --property=Environment --value | tr ' ' '\n')

  data_roots+=("/root/.local/share")
  for home in /home/*; do
    [ -d "\$home" ] && data_roots+=("\$home/.local/share")
  done

  local seen=" "
  local root cache_dir
  for root in "\${data_roots[@]}"; do
    [ -n "\$root" ] || continue
    case "\$seen" in *" \$root "*) continue ;; esac
    seen="\$seen\$root "
    cache_dir="\$root/boxlite/runtimes/\$version_dir"
    [ -d "\$cache_dir" ] && printf '%s\n' "\$cache_dir"
  done
}

verify_embedded_runtime_hash() {
  local checked=0
  local cache_dir guest_hash

  if [ -z "\${GUEST_EXPECTED:-}" ]; then
    echo "embedded runtime guest hash verification skipped: no expected guest hash sidecar"
    return 0
  fi

  while IFS= read -r cache_dir; do
    [ -n "\$cache_dir" ] || continue
    if [ ! -f "\$cache_dir/boxlite-guest" ]; then
      continue
    fi
    checked=\$((checked + 1))
    guest_hash=\$(sha256sum "\$cache_dir/boxlite-guest" | awk '{print \$1}')
    if [ "\$guest_hash" != "\$GUEST_EXPECTED" ]; then
      echo "FATAL: embedded runtime guest hash mismatch in \$cache_dir (expected=\${GUEST_EXPECTED:0:12} actual=\${guest_hash:0:12})" >&2
      return 1
    fi
    echo "embedded runtime guest hash verified: \${guest_hash:0:12} (\$cache_dir)"
  done < <(runtime_cache_dirs)

  if [ "\$checked" -eq 0 ]; then
    echo "embedded runtime guest hash verification deferred: runtime cache not extracted yet for \$RUNTIME_CACHE_DIR_NAME"
  fi
}

verify_hot_adopted_shims() {
  local count=0
  if [ ! -s "\$HOT_SNAPSHOT" ]; then
    echo "hot rollout: no live detached shims to adopt"
    return 0
  fi

  while read -r box_id before_pid before_start; do
    [ -n "\$box_id" ] || continue
    count=\$((count + 1))
    local pid_file now_pid now_start
    pid_file="\$BOXLITE_HOME_DIR/boxes/\$box_id/shim.pid"
    now_pid="\$(sed -n '1p' "\$pid_file" 2>/dev/null | tr -dc '0-9')"
    now_start="\$(sed -n '2p' "\$pid_file" 2>/dev/null | tr -dc '0-9')"
    [ "\$now_pid" = "\$before_pid" ] || {
      echo "FATAL: box \$box_id shim pid changed across rollout (before=\$before_pid after=\$now_pid)" >&2
      return 1
    }
    pid_alive "\$now_pid" || {
      echo "FATAL: box \$box_id shim pid \$now_pid is not alive after rollout" >&2
      return 1
    }
    if [ -n "\$before_start" ]; then
      [ "\$now_start" = "\$before_start" ] || {
        echo "FATAL: box \$box_id shim start-time changed across rollout" >&2
        return 1
      }
      [ "\$(proc_start_time "\$now_pid")" = "\$before_start" ] || {
        echo "FATAL: box \$box_id shim pid \$now_pid failed start-time verification" >&2
        return 1
      }
    fi

    # This forces the new runner process through getOrFetchBox -> runtime.Get ->
    # vmm_attach for boxes that only existed in the previous runner's memory.
    curl -fsS "\${CURL_TLS[@]}" \
      -H "Authorization: Bearer \$BOXLITE_RUNNER_TOKEN" \
      "\$RUNNER_BASE_URL/v1/boxes/\$box_id/metrics" >/dev/null || {
        echo "FATAL: new runner failed to attach/probe detached box \$box_id" >&2
        return 1
      }
    echo "hot rollout: adopted \$box_id pid=\$now_pid"
  done < "\$HOT_SNAPSHOT"

  echo "hot rollout: adopted \$count detached box(es)"
}

prepare_release_target() {
  local source_binary="\$1"
  local release_id="\$2"
  local release_dir="\$RELEASES_DIR/\$release_id"
  mkdir -p "\$release_dir"
  install -m 0755 "\$source_binary" "\$release_dir/boxlite-runner"
  sha256sum "\$release_dir/boxlite-runner" | awk '{print \$1}' > "\$release_dir/boxlite-runner.sha256"
  printf '%s\n' "\$release_dir/boxlite-runner"
}

verify_release_target() {
  local target="\$1"
  local label="\$2"
  local expected actual sha_file

  if [ ! -x "\$target" ]; then
    echo "FATAL: \$label runner target is not executable: \$target" >&2
    return 1
  fi

  sha_file="\$(dirname "\$target")/boxlite-runner.sha256"
  actual=\$(sha256sum "\$target" | awk '{print \$1}')
  if [ -f "\$sha_file" ]; then
    expected=\$(awk '{print \$1}' "\$sha_file")
    if [ "\$expected" != "\$actual" ]; then
      echo "FATAL: \$label runner target hash mismatch: \$target (expected=\${expected:0:12} actual=\${actual:0:12})" >&2
      return 1
    fi
  else
    echo "\$actual" > "\$sha_file"
    echo "WARNING: \$label runner target had no hash sidecar; recorded current hash \${actual:0:12}" >&2
  fi

  echo "\$label runner target verified: \${actual:0:12} (\$target)"
}

current_runner_target() {
  if [ -L "\$RUNNER_BIN" ]; then
    readlink -f "\$RUNNER_BIN" 2>/dev/null || true
  elif [ -x "\$RUNNER_BIN" ]; then
    local legacy_dir="\$RELEASES_DIR/legacy-\$(date +%Y%m%d%H%M%S)"
    mkdir -p "\$legacy_dir"
    cp -a "\$RUNNER_BIN" "\$legacy_dir/boxlite-runner"
    sha256sum "\$legacy_dir/boxlite-runner" | awk '{print \$1}' > "\$legacy_dir/boxlite-runner.sha256"
    printf '%s\n' "\$legacy_dir/boxlite-runner"
  fi
}

activate_runner_target() {
  local target="\$1"
  ln -sfn "\$target" "\$RUNNER_BIN"
}

prune_old_releases() {
  [ "\$KEEP_RELEASES" -gt 0 ] 2>/dev/null || return 0
  [ -d "\$RELEASES_DIR" ] || return 0
  find "\$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn \
    | awk -v keep="\$KEEP_RELEASES" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
    | while IFS= read -r old_dir; do
        rm -rf "\$old_dir"
      done
}

restart_with_target() {
  local target="\$1"
  systemctl stop "\$SERVICE" || true
  activate_runner_target "\$target" || return 1
  systemctl start "\$SERVICE" || return 1
  sleep 2
  systemctl is-active --quiet "\$SERVICE" || return 1
  wait_runner_ready || return 1
  verify_runner_health_samples || return 1
  verify_embedded_runtime_hash || return 1
  verify_hot_adopted_shims || return 1
}

load_runner_env
snapshot_live_detached_shims
echo "hot rollout: captured \$(wc -l < "\$HOT_SNAPSHOT" | tr -d ' ') live detached shim(s)"

WORK=\$(mktemp -d)
trap 'rm -rf "\$WORK"; rm -f "\$HOT_SNAPSHOT"' EXIT
curl -fsSL "${PRESIGNED_TARBALL_URL}" -o "\$WORK/runner.tar.gz"
if curl -fsSL "${PRESIGNED_SHA_URL}" -o "\$WORK/runner.sha256"; then
  EXPECTED=\$(awk '{print \$1}' "\$WORK/runner.sha256")
  ACTUAL=\$(sha256sum "\$WORK/runner.tar.gz" | awk '{print \$1}')
  [ "\$EXPECTED" = "\$ACTUAL" ] || { echo "FATAL: checksum mismatch (want \$EXPECTED got \$ACTUAL)" >&2; exit 1; }
  echo "checksum verified (\$ACTUAL)"
else
  echo "WARNING: no checksum available for runner tarball; installing without integrity verification" >&2
fi
tar -xzf "\$WORK/runner.tar.gz" -C "\$WORK"
test -x "\$WORK/boxlite-runner" || { echo "FATAL: tarball has no boxlite-runner binary" >&2; exit 1; }
if [ -f "\$WORK/boxlite-runner.guest.sha256" ]; then
  GUEST_EXPECTED=\$(awk '{print \$1}' "\$WORK/boxlite-runner.guest.sha256")
  echo "runner expected guest hash: \${GUEST_EXPECTED:0:12}"
else
  GUEST_EXPECTED=""
  echo "WARNING: tarball has no guest hash sidecar; skipping pre-install guest hash verification" >&2
fi
if [ -f "\$WORK/boxlite-runner.runtime-suffix" ]; then
  RUNTIME_SUFFIX=\$(tr -dc 'A-Za-z0-9._-' < "\$WORK/boxlite-runner.runtime-suffix")
  if [ -n "\$RUNTIME_SUFFIX" ]; then
    RUNTIME_CACHE_DIR_NAME="v${RUNTIME_CACHE_VERSION}-\$RUNTIME_SUFFIX"
    echo "runner runtime cache key: \$RUNTIME_CACHE_DIR_NAME"
  else
    RUNTIME_CACHE_DIR_NAME="v${RUNTIME_CACHE_VERSION}"
    echo "WARNING: runtime suffix sidecar is empty; using \$RUNTIME_CACHE_DIR_NAME" >&2
  fi
else
  RUNTIME_CACHE_DIR_NAME="v${RUNTIME_CACHE_VERSION}"
  echo "runner runtime cache key: \$RUNTIME_CACHE_DIR_NAME"
fi

CURRENT_TARGET=\$(current_runner_target)
NEW_TARGET=\$(prepare_release_target "\$WORK/boxlite-runner" "v${VERSION}")
verify_release_target "\$NEW_TARGET" "new" || exit 1
echo "install target: \$NEW_TARGET"
if [ -n "\$CURRENT_TARGET" ]; then
  verify_release_target "\$CURRENT_TARGET" "rollback" || exit 1
  echo "rollback target: \$CURRENT_TARGET"
else
  echo "rollback target: none"
fi

# Swap + start + health as one guarded condition: a failing step here (install error,
# start failure, or an unhealthy unit) routes to the rollback branch instead of aborting
# the script under set -e — commands in an if-condition are exempt from set -e.
if restart_with_target "\$NEW_TARGET"; then
  prune_old_releases
  echo "systemd unit: active"
else
  echo "upgrade failed or detached-box adoption failed; rolling back" >&2
  if [ -n "\$CURRENT_TARGET" ]; then
    if restart_with_target "\$CURRENT_TARGET"; then
      echo "rollback complete"
    else
      echo "rollback failed" >&2
    fi
  fi
  journalctl -u "\$SERVICE" --no-pager -n 50 || true
  exit 1
fi
EOF

# Hand the script to SSM base64-encoded rather than quote-escaped: the payload
# becomes a single token with no shell metacharacters, sidestepping the brittle
# sed-escaping of a multi-line script inside the commands=[...] shorthand.
SCRIPT_B64=$(printf '%s' "$SCRIPT" | base64 | tr -d '\n')
CMD_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --comment "boxlite-runner upgrade to v$VERSION" \
  --parameters "commands=[\"echo $SCRIPT_B64 | base64 -d | bash\"]" \
  --query 'Command.CommandId' --output text)

echo "    command:  $CMD_ID"
echo "==> Waiting for SSM command to finish..."

aws ssm wait command-executed --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID"

STATUS=$(aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'Status' --output text)

echo
echo "==> SSM status: $STATUS"
echo
aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

if [[ "$STATUS" != "Success" ]]; then
  echo
  echo "==> stderr:"
  aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text
  exit 1
fi
