#!/bin/bash
# GCE startup script for the BoxLite ClickHouse host. The GCP counterpart of
# apps/infra/scripts/clickhouse-host.ts (EC2 user-data) plus the reconcile half
# of apps/infra/scripts/clickhouse-ops.mjs, folded into one file because the
# operator cannot SSH into the VM.
#
# GCE runs this on EVERY boot, so every step is idempotent: packages install
# once, the data disk is formatted once, files are rewritten only when their
# content changes, and the schema/grants/TTL statements are no-ops when the
# database already matches.
#
# Parameters come from instance metadata attributes (set by
# create-clickhouse-host.sh): clickhouse-image, clickhouse-retention-hours,
# clickhouse-data-device, clickhouse-secret-admin, clickhouse-secret-writer,
# clickhouse-secret-reader, clickhouse-schema (rendered SQL).
#
# Progress is reported to the guest attribute boxlite/clickhouse:
#   starting:<boot-id>  failed:<step>  ready:<image digest>:<table count>:<boot-id>
# Passwords are fetched from Secret Manager with the VM's service account and
# never written to disk; only their sha256 reaches ClickHouse.

set -Eeuo pipefail
exec > >(tee -a /var/log/boxlite-clickhouse-setup.log) 2>&1

MD="http://metadata.google.internal/computeMetadata/v1"
md() { curl -sf -H 'Metadata-Flavor: Google' "$MD/$1"; }
attr() { md "instance/attributes/$1"; }
report() {
    curl -sf -X PUT --data "$1" -H 'Metadata-Flavor: Google' \
        "$MD/instance/guest-attributes/boxlite/clickhouse" >/dev/null 2>&1 || true
}

STEP=init
on_error() {
    report "failed:$STEP"
    echo "FATAL: step $STEP failed" >&2
}
trap on_error ERR
# The boot id makes every boot's `ready` value distinct, so an operator
# waiting across a reset can tell a fresh report from the previous boot's.
BOOT_ID="$(cut -c1-8 /proc/sys/kernel/random/boot_id)"
report "starting:$BOOT_ID"

TABLES=(otel_logs otel_traces otel_metrics_gauge otel_metrics_sum otel_metrics_summary otel_metrics_histogram otel_metrics_exponential_histogram)

# ---------------------------------------------------------------------------
STEP=metadata
IMAGE="$(attr clickhouse-image)"
RETENTION_HOURS="$(attr clickhouse-retention-hours)"
DATA_DEVICE="$(attr clickhouse-data-device)"
ADMIN_SECRET="$(attr clickhouse-secret-admin)"
WRITER_SECRET="$(attr clickhouse-secret-writer)"
READER_SECRET="$(attr clickhouse-secret-reader)"
# One check per attribute: a failing test inside an && chain does not stop a
# set -e script, so each one fails on its own.
for name in IMAGE DATA_DEVICE ADMIN_SECRET WRITER_SECRET READER_SECRET; do
    [ -n "${!name}" ] || { echo "FATAL: metadata attribute for $name is empty" >&2; false; }
done
[[ "$RETENTION_HOURS" =~ ^[0-9]+$ ]] || { echo "FATAL: clickhouse-retention-hours is not an integer: '$RETENTION_HOURS'" >&2; false; }
install -d -m 0750 /opt/boxlite-clickhouse
attr clickhouse-schema > /opt/boxlite-clickhouse/schema.sql.new
grep -q 'CREATE TABLE' /opt/boxlite-clickhouse/schema.sql.new
echo "image=$IMAGE retention=${RETENTION_HOURS}h device=$DATA_DEVICE"

# ---------------------------------------------------------------------------
STEP=packages
if ! command -v docker >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io curl python3
fi
systemctl enable --now docker

# ---------------------------------------------------------------------------
STEP=disk
DEVICE="/dev/disk/by-id/google-${DATA_DEVICE}"
for _ in $(seq 1 120); do
    [ -b "$DEVICE" ] && break
    sleep 5
done
[ -b "$DEVICE" ] || { echo "FATAL: data disk $DEVICE is not attached" >&2; false; }
if ! blkid "$DEVICE" >/dev/null 2>&1; then
    mkfs.ext4 -F "$DEVICE"
fi
DATA_UUID="$(blkid -s UUID -o value "$DEVICE")"
install -d -m 0750 /var/lib/boxlite-clickhouse
if ! grep -q "UUID=${DATA_UUID}" /etc/fstab; then
    printf 'UUID=%s /var/lib/boxlite-clickhouse ext4 defaults 0 2\n' "$DATA_UUID" >> /etc/fstab
fi
mountpoint -q /var/lib/boxlite-clickhouse || mount /var/lib/boxlite-clickhouse
install -d -m 0750 /var/lib/boxlite-clickhouse/data

# ---------------------------------------------------------------------------
# Files are rewritten only when their content changes, so a warm boot does
# not restart ClickHouse for nothing.
CHANGED=0
put_file() {
    local path="$1" mode="$2" tmp
    tmp="$(mktemp "${path}.XXXXXX")"
    cat > "$tmp"
    chmod "$mode" "$tmp"
    if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
        rm -f "$tmp"
    else
        mv -f "$tmp" "$path"
        CHANGED=1
    fi
}

STEP=secret-access
# Replaces the AWS `aws secretsmanager get-secret-value` helper. Exit codes
# tell the boot log apart: 43 = no permission, 44 = no such secret/version.
put_file /usr/local/bin/boxlite-clickhouse-secret 0700 <<'SCRIPT'
#!/bin/bash
# Print the latest version of Secret Manager secret $1 using the VM's service account.
set -euo pipefail
umask 077
MD="http://metadata.google.internal/computeMetadata/v1"
PROJECT="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/project/project-id")"
TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
BODY="$(mktemp /run/boxlite-clickhouse-secret.XXXXXX)"
trap 'rm -f "$BODY"' EXIT
CODE="$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access")"
case "$CODE" in
    200) ;;
    403) echo "secret $1: HTTP 403, the VM service account lacks roles/secretmanager.secretAccessor" >&2; exit 43 ;;
    404) echo "secret $1: HTTP 404, secret or enabled version missing" >&2; exit 44 ;;
    *)   echo "secret $1: HTTP $CODE" >&2; exit 45 ;;
esac
python3 -c 'import sys,json,base64; sys.stdout.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())' < "$BODY"
SCRIPT
# Fail closed before writing any unit: probe the admin secret once so the
# guest attribute names the exact problem.
if /usr/local/bin/boxlite-clickhouse-secret "$ADMIN_SECRET" >/dev/null; then
    probe_rc=0
else
    probe_rc=$?
fi
case "$probe_rc" in
    0) ;;
    44) STEP=secret-missing; false ;;
    *) STEP=secret-access; false ;;
esac

# ---------------------------------------------------------------------------
STEP=files
put_file /etc/boxlite-clickhouse.conf 0600 <<ENV
ADMIN_SECRET=${ADMIN_SECRET}
WRITER_SECRET=${WRITER_SECRET}
READER_SECRET=${READER_SECRET}
CLICKHOUSE_IMAGE=${IMAGE}
ENV

# Runs as ExecStartPre on every service start, so a rotated admin secret only
# needs a restart. The XML lives on tmpfs and holds hashes, not passwords.
put_file /usr/local/bin/boxlite-clickhouse-credentials 0700 <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
source /etc/boxlite-clickhouse.conf
ADMIN_PASSWORD="$(/usr/local/bin/boxlite-clickhouse-secret "$ADMIN_SECRET")"
ADMIN_HASH="$(printf %s "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')"
unset ADMIN_PASSWORD
cat > /run/boxlite-clickhouse-users.xml <<XML
<clickhouse><users>
  <default replace="replace"><password_sha256_hex>$ADMIN_HASH</password_sha256_hex><networks><ip>127.0.0.1</ip><ip>::1</ip></networks></default>
  <boxlite_admin><password_sha256_hex>$ADMIN_HASH</password_sha256_hex><networks><ip>::/0</ip></networks><access_management>1</access_management></boxlite_admin>
</users></clickhouse>
XML
chown 101:101 /run/boxlite-clickhouse-users.xml
chmod 0400 /run/boxlite-clickhouse-users.xml
SCRIPT

put_file /usr/local/bin/boxlite-clickhouse-sql-users 0700 <<'SCRIPT'
#!/bin/bash
set -euo pipefail
source /etc/boxlite-clickhouse.conf
secret() { /usr/local/bin/boxlite-clickhouse-secret "$1"; }
ADMIN_PASSWORD="$(secret "$ADMIN_SECRET")"
WRITER_HASH="$(printf %s "$(secret "$WRITER_SECRET")" | sha256sum | awk '{print $1}')"
READER_HASH="$(printf %s "$(secret "$READER_SECRET")" | sha256sum | awk '{print $1}')"
for _ in $(seq 1 120); do
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

put_file /etc/systemd/system/boxlite-clickhouse.service 0644 <<'UNIT'
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

# ---------------------------------------------------------------------------
STEP=service
systemctl daemon-reload
systemctl enable boxlite-clickhouse >/dev/null 2>&1 || true
running_image="$(docker inspect --format '{{.Config.Image}}' boxlite-clickhouse 2>/dev/null || true)"
if [ "$CHANGED" = 1 ] || [ "$running_image" != "$IMAGE" ]; then
    systemctl restart boxlite-clickhouse
else
    systemctl start boxlite-clickhouse
fi
systemctl is-active --quiet boxlite-clickhouse

# ---------------------------------------------------------------------------
STEP=image
# The pull happens inside ExecStartPre, so the container can take a while to
# appear on a cold boot.
for _ in $(seq 1 120); do
    running_image="$(docker inspect --format '{{.Config.Image}}' boxlite-clickhouse 2>/dev/null || true)"
    [ "$running_image" = "$IMAGE" ] && break
    sleep 5
done
[ "$running_image" = "$IMAGE" ] || { echo "FATAL: running image '$running_image' is not '$IMAGE'" >&2; false; }

# ---------------------------------------------------------------------------
STEP=sql-users
/usr/local/bin/boxlite-clickhouse-sql-users

# ---------------------------------------------------------------------------
# Everything below mirrors buildSelfHostedReadinessCommand in
# apps/infra/scripts/clickhouse-ops.mjs.
ch() {
    # ch <user> <password> <clickhouse-client args...>; stdin passes through.
    local user="$1" password="$2"
    shift 2
    CLICKHOUSE_PASSWORD="$password" docker exec -i -e CLICKHOUSE_PASSWORD boxlite-clickhouse \
        clickhouse-client --user "$user" "$@"
}
ADMIN_PASSWORD="$(/usr/local/bin/boxlite-clickhouse-secret "$ADMIN_SECRET")"

STEP=schema
mv -f /opt/boxlite-clickhouse/schema.sql.new /opt/boxlite-clickhouse/schema.sql
ch boxlite_admin "$ADMIN_PASSWORD" --multiquery < /opt/boxlite-clickhouse/schema.sql

STEP=grants-ttl
ttl_column() {
    case "$1" in
        otel_logs) echo TimestampTime ;;
        otel_traces) echo Timestamp ;;
        *) echo TimeUnix ;;
    esac
}
{
    echo "GRANT SELECT, INSERT, SHOW COLUMNS ON otel.* TO otel_writer;"
    echo "GRANT SELECT, SHOW COLUMNS ON otel.* TO otel_reader;"
    for table in "${TABLES[@]}"; do
        echo "ALTER TABLE otel.${table} MODIFY TTL toDateTime($(ttl_column "$table")) + INTERVAL ${RETENTION_HOURS} HOUR;"
    done
} | ch boxlite_admin "$ADMIN_PASSWORD" --multiquery

STEP=assert
for table in "${TABLES[@]}"; do
    ch boxlite_admin "$ADMIN_PASSWORD" --query "DESCRIBE TABLE otel.${table}" >/dev/null
done
table_count="$(ch boxlite_admin "$ADMIN_PASSWORD" --query \
    "SELECT count() FROM system.tables WHERE database = 'otel' AND position(create_table_query, 'toIntervalHour(${RETENTION_HOURS})') > 0")"
[ "$table_count" = "${#TABLES[@]}" ] || { echo "FATAL: $table_count of ${#TABLES[@]} tables carry the ${RETENTION_HOURS}h TTL" >&2; false; }
ch boxlite_admin "$ADMIN_PASSWORD" --query "SHOW GRANTS FOR otel_writer" | grep -q 'SHOW COLUMNS'
ch boxlite_admin "$ADMIN_PASSWORD" --query "SHOW GRANTS FOR otel_reader" | grep -q 'SELECT'
WRITER_PASSWORD="$(/usr/local/bin/boxlite-clickhouse-secret "$WRITER_SECRET")"
READER_PASSWORD="$(/usr/local/bin/boxlite-clickhouse-secret "$READER_SECRET")"
for table in "${TABLES[@]}"; do
    column=Timestamp
    case "$table" in otel_logs|otel_traces) ;; *) column=TimeUnix ;; esac
    ch otel_writer "$WRITER_PASSWORD" --query "INSERT INTO otel.${table} (${column}) VALUES (now64(9))"
done
ch otel_reader "$READER_PASSWORD" --query "SELECT count() FROM otel.otel_logs" >/dev/null
unset ADMIN_PASSWORD WRITER_PASSWORD READER_PASSWORD

# ---------------------------------------------------------------------------
STEP=done
report "ready:${IMAGE#*@}:${#TABLES[@]}:$BOOT_ID"
echo "ClickHouse is ready: $IMAGE, ${#TABLES[@]} tables, ${RETENTION_HOURS}h TTL"
