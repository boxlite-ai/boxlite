#!/usr/bin/env bash
# Upgrade the boxlite-runner binary on the live Runner EC2 in-place.
#
# Replaces /usr/local/bin/boxlite-runner with a freshly downloaded release
# binary and restarts the systemd unit. The EC2 instance itself is not
# replaced; box state under /var/lib/boxlite is preserved.
#
# Pair with the `ignoreChanges: ["ami", "userDataBase64"]` setting on the
# Runner resource in apps/infra/sst.config.ts — that prevents `sst deploy`
# from recreating the instance on Cargo.toml version bumps; this script is
# how the new version actually lands on the running instance.
#
# Usage:
#   scripts/deploy/runner-update-binary.sh                  # version from Cargo.toml
#   scripts/deploy/runner-update-binary.sh 0.9.5            # explicit version
#   AWS_REGION=us-west-2 scripts/deploy/runner-update-binary.sh
#   STAGE=production scripts/deploy/runner-update-binary.sh

set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
STAGE="${STAGE:-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -ge 1 ]]; then
  VERSION="$1"
else
  VERSION=$(grep -m 1 '^version' "$REPO_ROOT/Cargo.toml" | sed -E 's/^version *= *"([^"]+)".*/\1/')
  if [[ -z "$VERSION" ]]; then
    echo "error: could not read version from Cargo.toml at $REPO_ROOT/Cargo.toml" >&2
    exit 1
  fi
fi

echo "==> Upgrading boxlite-runner to v$VERSION on stage=$STAGE region=$AWS_REGION"

INSTANCE_ID=$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=boxlite-runner" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "error: no running boxlite-runner instance found in region $AWS_REGION" >&2
  exit 1
fi
echo "    instance: $INSTANCE_ID"

ASSET_BASE="https://github.com/boxlite-ai/boxlite/releases/download/v${VERSION}"
ASSET_TARBALL="boxlite-runner-v${VERSION}-linux-amd64.tar.gz"

# Remote upgrade script. Mirrors the boot user-data's integrity policy and adds a
# rollback: download + checksum-verify BEFORE stopping the unit (so a failed or
# corrupt fetch never takes the runner down), back up the live binary, swap it in,
# and restore the backup if the new binary fails to come up.
read -r -d '' SCRIPT <<EOF || true
set -euo pipefail
echo "current version:"
/usr/local/bin/boxlite-runner --version || true

WORK=\$(mktemp -d)
trap 'rm -rf "\$WORK"' EXIT
curl -fsSL "${ASSET_BASE}/${ASSET_TARBALL}" -o "\$WORK/runner.tar.gz"
if curl -fsSL "${ASSET_BASE}/${ASSET_TARBALL}.sha256" -o "\$WORK/runner.sha256"; then
  EXPECTED=\$(awk '{print \$1}' "\$WORK/runner.sha256")
  ACTUAL=\$(sha256sum "\$WORK/runner.tar.gz" | awk '{print \$1}')
  [ "\$EXPECTED" = "\$ACTUAL" ] || { echo "FATAL: checksum mismatch (want \$EXPECTED got \$ACTUAL)" >&2; exit 1; }
  echo "checksum verified (\$ACTUAL)"
else
  echo "WARNING: no .sha256 published for v${VERSION}; installing without integrity verification" >&2
fi
tar -xzf "\$WORK/runner.tar.gz" -C "\$WORK"
test -x "\$WORK/boxlite-runner" || { echo "FATAL: tarball has no boxlite-runner binary" >&2; exit 1; }

# Back up the live binary (if any) so a failed swap or start can roll back.
HAD_PREVIOUS=false
if [ -x /usr/local/bin/boxlite-runner ]; then
  cp -a /usr/local/bin/boxlite-runner /usr/local/bin/boxlite-runner.bak
  HAD_PREVIOUS=true
fi
systemctl stop boxlite-runner || true
# Swap + start + health as one guarded condition: a failing step here (install error,
# start failure, or an unhealthy unit) routes to the rollback branch instead of aborting
# the script under set -e — commands in an if-condition are exempt from set -e.
if install -m 0755 "\$WORK/boxlite-runner" /usr/local/bin/boxlite-runner && systemctl start boxlite-runner && sleep 2 && systemctl is-active --quiet boxlite-runner; then
  [ "\$HAD_PREVIOUS" = true ] && rm -f /usr/local/bin/boxlite-runner.bak
  echo "systemd unit: active"
  echo "new version:"
  /usr/local/bin/boxlite-runner --version
else
  echo "upgrade failed; rolling back" >&2
  if [ "\$HAD_PREVIOUS" = true ]; then
    mv -f /usr/local/bin/boxlite-runner.bak /usr/local/bin/boxlite-runner
    systemctl restart boxlite-runner || true
  fi
  journalctl -u boxlite-runner --no-pager -n 50 || true
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
