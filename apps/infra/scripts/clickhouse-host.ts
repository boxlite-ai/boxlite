// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CLICKHOUSE_IMAGE =
  'clickhouse/clickhouse-server@sha256:c67cd26ea87301f3115e5fa7822905bcbb89cbd81e52bdd1ab7a938d1d5b77d8'
export const EC2_USER_DATA_MAX_BYTES = 16 * 1024
export const CLICKHOUSE_RETENTION_HOURS = 72

export interface ClickHouseUserDataInput {
  region: string
  volumeId: string
  adminSecretArn: string
  writerSecretArn: string
  readerSecretArn: string
  image?: string
}

const schemaSource = [
  new URL('../clickhouse/otel-schema-v0.144.0.sql', import.meta.url),
  resolve(process.cwd(), 'clickhouse/otel-schema-v0.144.0.sql'),
  resolve(process.cwd(), 'apps/infra/clickhouse/otel-schema-v0.144.0.sql'),
].find((candidate) => existsSync(candidate))
if (!schemaSource) throw new Error('clickhouse/otel-schema-v0.144.0.sql was not found')
const schemaTemplate = readFileSync(schemaSource, 'utf8')

export function renderClickHouseSchema() {
  return schemaTemplate.replaceAll('__RETENTION_HOURS__', String(CLICKHOUSE_RETENTION_HOURS))
}

function shellLiteral(value: string) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function requireBootstrapInput(
  input: ClickHouseUserDataInput,
  name: 'region' | 'volumeId' | 'adminSecretArn' | 'writerSecretArn' | 'readerSecretArn',
) {
  const value = input[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required for ClickHouse bootstrap`)
  return value
}

/** Build secret-free EC2 user data. Secret values are fetched by the instance role at runtime. */
export function buildClickHouseUserData(input: ClickHouseUserDataInput) {
  const region = requireBootstrapInput(input, 'region')
  const volumeId = requireBootstrapInput(input, 'volumeId')
  const adminSecretArn = requireBootstrapInput(input, 'adminSecretArn')
  const writerSecretArn = requireBootstrapInput(input, 'writerSecretArn')
  const readerSecretArn = requireBootstrapInput(input, 'readerSecretArn')
  const image = input.image || CLICKHOUSE_IMAGE
  const nvmeVolumeId = volumeId.replaceAll('-', '')

  return `#!/bin/bash
set -euo pipefail
exec > /var/log/clickhouse-setup.log 2>&1

AWS_REGION=${shellLiteral(region)}
VOLUME_ID=${shellLiteral(volumeId)}
NVME_VOLUME_ID=${shellLiteral(nvmeVolumeId)}
ADMIN_SECRET_ARN=${shellLiteral(adminSecretArn)}
WRITER_SECRET_ARN=${shellLiteral(writerSecretArn)}
READER_SECRET_ARN=${shellLiteral(readerSecretArn)}
CLICKHOUSE_IMAGE=${shellLiteral(image)}

while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io curl unzip
AWS_CLI_TMP=$(mktemp -d)
trap 'rm -rf "$AWS_CLI_TMP"' EXIT
curl --fail --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 300 \
  --output "$AWS_CLI_TMP/awscliv2.zip" \
  https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
unzip -q "$AWS_CLI_TMP/awscliv2.zip" -d "$AWS_CLI_TMP"
"$AWS_CLI_TMP/aws/install" --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update
rm -rf "$AWS_CLI_TMP"
trap - EXIT
/usr/local/bin/aws --version 2>&1 | grep -q '^aws-cli/2\\.'
systemctl enable --now docker

DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_\${NVME_VOLUME_ID}"
for attempt in $(seq 1 120); do
  [ -b "\${DEVICE}" ] && break
  sleep 5
done
[ -b "\${DEVICE}" ] || { echo "FATAL: EBS volume \${VOLUME_ID} did not attach" >&2; exit 1; }

if ! blkid "\${DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -F "\${DEVICE}"
fi
DATA_UUID=$(blkid -s UUID -o value "\${DEVICE}")
install -d -m 0750 /var/lib/boxlite-clickhouse
if ! grep -q "UUID=\${DATA_UUID}" /etc/fstab; then
  printf 'UUID=%s /var/lib/boxlite-clickhouse ext4 defaults 0 2\n' "\${DATA_UUID}" >> /etc/fstab
fi
mountpoint -q /var/lib/boxlite-clickhouse || mount /var/lib/boxlite-clickhouse
install -d -m 0750 /var/lib/boxlite-clickhouse/data /opt/boxlite-clickhouse

cat > /usr/local/bin/boxlite-clickhouse-credentials <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
secret() { aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" --query SecretString --output text; }
ADMIN_PASSWORD=$(secret "$ADMIN_SECRET_ARN")
ADMIN_HASH=$(printf %s "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')
cat > /run/boxlite-clickhouse-users.xml <<XML
<clickhouse><users>
  <default replace="replace"><password_sha256_hex>$ADMIN_HASH</password_sha256_hex><networks><ip>127.0.0.1</ip><ip>::1</ip></networks></default>
  <boxlite_admin><password_sha256_hex>$ADMIN_HASH</password_sha256_hex><networks><ip>::/0</ip></networks><access_management>1</access_management></boxlite_admin>
</users></clickhouse>
XML
chown 101:101 /run/boxlite-clickhouse-users.xml
chmod 0400 /run/boxlite-clickhouse-users.xml
SCRIPT
chmod 0700 /usr/local/bin/boxlite-clickhouse-credentials

cat > /usr/local/bin/boxlite-clickhouse-sql-users <<'SCRIPT'
#!/bin/bash
set -euo pipefail
source /etc/boxlite-clickhouse.conf
secret() { aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" --query SecretString --output text; }
ADMIN_PASSWORD=$(secret "$ADMIN_SECRET_ARN")
WRITER_HASH=$(printf %s "$(secret "$WRITER_SECRET_ARN")" | sha256sum | awk '{print $1}')
READER_HASH=$(printf %s "$(secret "$READER_SECRET_ARN")" | sha256sum | awk '{print $1}')
for attempt in $(seq 1 120); do
  CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse \
    clickhouse-client --user boxlite_admin --query 'SELECT 1' >/dev/null 2>&1 && break
  sleep 5
done
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse \
  clickhouse-client --user boxlite_admin --query 'SELECT 1' >/dev/null
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -i -e CLICKHOUSE_PASSWORD boxlite-clickhouse \
  clickhouse-client --user boxlite_admin --multiquery <<SQL
CREATE USER IF NOT EXISTS otel_writer IDENTIFIED WITH sha256_hash BY '$WRITER_HASH';
ALTER USER otel_writer IDENTIFIED WITH sha256_hash BY '$WRITER_HASH';
CREATE USER IF NOT EXISTS otel_reader IDENTIFIED WITH sha256_hash BY '$READER_HASH';
ALTER USER otel_reader IDENTIFIED WITH sha256_hash BY '$READER_HASH';
SQL
unset ADMIN_PASSWORD WRITER_HASH READER_HASH
SCRIPT
chmod 0700 /usr/local/bin/boxlite-clickhouse-sql-users

cat > /etc/systemd/system/boxlite-clickhouse.service <<'UNIT'
[Unit]
Description=BoxLite ClickHouse
After=docker.service network-online.target var-lib-boxlite\x2dclickhouse.mount
Requires=docker.service
RequiresMountsFor=/var/lib/boxlite-clickhouse

[Service]
Type=simple
EnvironmentFile=/etc/boxlite-clickhouse.conf
ExecStartPre=/usr/local/bin/boxlite-clickhouse-credentials
ExecStartPre=-/usr/bin/docker rm -f boxlite-clickhouse
ExecStartPre=/usr/bin/docker pull $CLICKHOUSE_IMAGE
ExecStart=/usr/bin/docker run --rm --name boxlite-clickhouse --network host --ulimit nofile=262144:262144 -v /var/lib/boxlite-clickhouse/data:/var/lib/clickhouse -v /run/boxlite-clickhouse-users.xml:/etc/clickhouse-server/users.d/boxlite-users.xml:ro $CLICKHOUSE_IMAGE
ExecStop=/usr/bin/docker stop -t 60 boxlite-clickhouse
Restart=always
RestartSec=5
TimeoutStartSec=0
TimeoutStopSec=75

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/boxlite-clickhouse.conf <<ENV
AWS_REGION=\${AWS_REGION}
ADMIN_SECRET_ARN=\${ADMIN_SECRET_ARN}
WRITER_SECRET_ARN=\${WRITER_SECRET_ARN}
READER_SECRET_ARN=\${READER_SECRET_ARN}
CLICKHOUSE_IMAGE=\${CLICKHOUSE_IMAGE}
ENV
chmod 0600 /etc/boxlite-clickhouse.conf
systemctl daemon-reload
systemctl enable --now boxlite-clickhouse
`
}

/** Encode the bootstrap for EC2 while keeping the decoded payload inside AWS's user-data limit. */
export function encodeClickHouseUserData(input: ClickHouseUserDataInput) {
  const userData = Buffer.from(buildClickHouseUserData(input))
  if (userData.byteLength > EC2_USER_DATA_MAX_BYTES) {
    throw new Error(
      `ClickHouse user data is ${userData.byteLength} bytes; EC2 allows ${EC2_USER_DATA_MAX_BYTES}`,
    )
  }
  return userData.toString('base64')
}
