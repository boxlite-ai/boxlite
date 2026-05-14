#!/usr/bin/env bash
# Upgrade the boxlite-runner binary on the live Runner EC2 in-place.
#
# Replaces /usr/local/bin/boxlite-runner with a freshly downloaded release
# binary and restarts the systemd unit. The EC2 instance itself is not
# replaced; sandbox state under /var/lib/boxlite is preserved.
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

ASSET_URL="https://github.com/boxlite-ai/boxlite/releases/download/v${VERSION}/boxlite-runner-v${VERSION}-linux-amd64.tar.gz"

read -r -d '' SCRIPT <<EOF || true
set -euo pipefail
echo "current version:"
/usr/local/bin/boxlite-runner --version || true

systemctl stop boxlite-runner
curl -fsSL "${ASSET_URL}" | tar xz -C /usr/local/bin/
chmod +x /usr/local/bin/boxlite-runner
systemctl start boxlite-runner

sleep 2
echo "new version:"
/usr/local/bin/boxlite-runner --version

systemctl is-active --quiet boxlite-runner && echo "systemd unit: active" || (echo "systemd unit FAILED"; journalctl -u boxlite-runner --no-pager -n 50; exit 1)
EOF

CMD_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --comment "boxlite-runner upgrade to v$VERSION" \
  --parameters "commands=[\"$(printf '%s' "$SCRIPT" | sed 's/"/\\"/g')\"]" \
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
