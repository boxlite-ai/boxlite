/*
 * ClickHouse on GCP: one private instance this stack owns, or an endpoint it
 * only records.
 *
 * The AWS side of this module runs a reconcile step over SSM — SQL executed on
 * the host, because the schema and the retention are not things a cloud API can
 * express. Google has no SSM, and the equivalent is not a smaller version of
 * the same thing: the instance is reached through IAP or through a startup
 * script, and neither is a resource the engine can re-run when a password
 * rotates.
 *
 * So the self-hosted path here does the reconcile from the *startup script*
 * instead, and accepts what that costs: the schema is applied at boot rather
 * than on every deploy, and a rotated password needs a restart rather than an
 * apply. That is a real difference in behaviour and it is written down rather
 * than smoothed over — the alternative was a local command that shells out to
 * `gcloud compute ssh`, which is a person's tool wearing a resource's clothes.
 *
 * `managed` and `disabled` behave exactly as they do on AWS, because neither
 * touches a machine.
 */

import { renderClickHouseSchema } from '../../../../scripts/clickhouse-host.js'
import type { ClickHouse, ClickHouseProvider, ClickHouseRequest } from '../../clickhouse.ts'
import type { NetworkBinding, WorkloadRole } from '../../network.ts'
import { identityFor, instanceFor } from 'naming'

/**
 * What each requested size answers to.
 *
 * N4, the same family the runner fleet uses, because this is the other machine
 * the AWS side runs on EC2. Nested virtualization is irrelevant here — nothing
 * on this host starts a VM — so what N4 buys is one machine generation across
 * the stack rather than two to keep in mind.
 */
export const MACHINE = { small: 'n4-standard-2', medium: 'n4-standard-4' } as const

/**
 * The only disk type N4 attaches, for the boot disk and the data disk alike.
 *
 * The family takes no Persistent Disk at all, so a `pd-balanced` data disk is
 * refused at create time rather than silently downgraded. A type chosen rather
 * than a type migrated: `dev` is the first GCP stage to hold a ClickHouse disk,
 * and a disk already created could not be converted in place — the retained one
 * would have to be replaced by hand, taking the history with it.
 */
export const DISK_TYPE = 'hyperdisk-balanced'

const HTTP_PORT = 8123

/**
 * Every role that speaks to this database, as the firewall has to name them.
 *
 * Two, and the second one is easy to lose: the collector writes and the API
 * reads back. A rule keyed on service accounts admits exactly what it lists, so
 * a caller left out is *dropped* rather than refused — the reader waits out a
 * connect timeout against a database that is plainly running, ClickHouse logs
 * nothing because nothing arrived, and the deny at 65534 is the only trace.
 *
 * Declared here, beside the rule that consumes it, rather than spelled out at
 * the composition root: that is where it was one account with a comment saying
 * two, which is a widening or a narrowing nothing type-checks.
 */
export const CLICKHOUSE_CALLERS: readonly WorkloadRole[] = ['otel-collector', 'api']

/** Ubuntu's own image family, the same release the runner hosts use. */
const IMAGE = 'ubuntu-os-cloud/ubuntu-2404-lts-amd64'

type ManagedSecret = { secret: CloudResource; version: CloudResource }

const clickHouseSecret = (resourceName: string, project: string, secretId: string): ManagedSecret => {
  const password = new random.RandomPassword(`${resourceName}Password`, { length: 32, special: false })
  const secret = new gcp.secretmanager.Secret(resourceName, {
    project,
    secretId,
    replication: { auto: {} },
  })
  const version = new gcp.secretmanager.SecretVersion(`${resourceName}Value`, {
    secret: secret.id,
    secretData: $util.secret(password.result),
  })
  return { secret, version }
}

/**
 * The OTLP schema, base64 so that one quoting problem cannot become two.
 *
 * The same vendored file the AWS side applies over SSM: seven tables and their
 * retention, defined once and applied from both clouds. The collector creates
 * none of it — `create_schema` is false in `apps/otel-collector/config.yaml` —
 * so a host that skipped this answers every insert with `UNKNOWN_TABLE` while
 * the instance, the firewall and the deploy all look healthy.
 */
const SCHEMA_BASE64 = Buffer.from(renderClickHouseSchema()).toString('base64')

/**
 * What the host does at every boot: mount its disk, install the server, then
 * reconcile the schema, the two accounts and their grants.
 *
 * A pure function rather than a template inside the provider, so the half that
 * decides SQL can be read back by a test; the provider only resolves the three
 * secret versions into it.
 */
export const clickHouseStartupScript = ({
  database,
  writerUsername,
  readerUsername,
  adminRef,
  writerRef,
  readerRef,
}: {
  database: string
  writerUsername: string
  readerUsername: string
  /** Secret Manager version names — `projects/…/secrets/…/versions/…`. */
  adminRef: string
  writerRef: string
  readerRef: string
}): string => `#!/bin/bash
set -euo pipefail
# The console as well as the file. Nobody can SSH to this host — OS Login
# refuses an account outside the instance's organization — so a failure whose
# only record is /var/log/clickhouse-setup.log is a failure nobody can read.
# Never add \`set -x\`: the two account passwords below are arguments to
# clickhouse-client, and this console is readable by anyone who can call
# compute.instances.getSerialPortOutput.
exec > >(tee /var/log/clickhouse-setup.log) 2>&1

# The data disk, formatted once and mounted every boot.
DEVICE=/dev/disk/by-id/google-clickhouse-data
if ! blkid "$DEVICE" >/dev/null 2>&1; then mkfs.ext4 -m 0 -F "$DEVICE"; fi
mkdir -p /var/lib/clickhouse
grep -q "$DEVICE" /etc/fstab || echo "$DEVICE /var/lib/clickhouse ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a

# A package manager still holding the lock from the image's own first boot, as
# the runner's boot script and the AWS host's user data both wait out.
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done

# The repository's signing key, from the path ClickHouse actually publishes it
# on: \`deb/pubkey.gpg\` answers 404 and has for years, and a 404 piped into gpg
# is \`exit status 2\` — the whole of what the first host on this stage reported.
# Retried and overwritable: the fetch is the first thing on this host to leave
# the network, and \`--yes\` is what makes the second boot behave like the first,
# since gpg refuses an existing keyring with that same status.
curl -fsSL --retry 5 --retry-all-errors --connect-timeout 10 --max-time 120 https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key | gpg --dearmor --yes -o /usr/share/keyrings/clickhouse.gpg
echo "deb [signed-by=/usr/share/keyrings/clickhouse.gpg] https://packages.clickhouse.com/deb stable main" > /etc/apt/sources.list.d/clickhouse.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y clickhouse-server clickhouse-client

read_secret() { gcloud secrets versions access "$1" --format='get(payload.data)' | base64 -d; }
ADMIN=$(read_secret "${adminRef}")
WRITER=$(read_secret "${writerRef}")
READER=$(read_secret "${readerRef}")

# Hashes, not passwords, from here on. ClickHouse echoes the statement it failed
# on — to this console, now — so a password that reaches SQL text or a command
# line is a password in a log anyone with the serial port can read.
hash_of() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
ADMIN_HASH=$(hash_of "$ADMIN")
WRITER_HASH=$(hash_of "$WRITER")
READER_HASH=$(hash_of "$READER")

# Listen on the private address only. The firewall says who may reach it; this
# says it will not answer anywhere else even if that changes.
cat > /etc/clickhouse-server/config.d/boxlite.xml << 'CONFIG'
<clickhouse>
  <listen_host>0.0.0.0</listen_host>
  <http_port>${HTTP_PORT}</http_port>
</clickhouse>
CONFIG

# The default account's password, in the file that owns it rather than in SQL:
# \`default\` comes from users.xml, and that storage is read-only — an
# \`ALTER USER default\` is refused with ACCESS_STORAGE_READONLY no matter who
# asks. Written before the first start so the account never exists unprotected.
cat > /etc/clickhouse-server/users.d/boxlite-default.xml << CONFIG
<clickhouse>
  <users>
    <default>
      <!-- The empty one users.xml ships. Removed rather than shadowed: two ways
           to authenticate one account is a config the server refuses to load. -->
      <password remove="remove"/>
      <password_sha256_hex>$ADMIN_HASH</password_sha256_hex>
    </default>
  </users>
</clickhouse>
CONFIG
chown root:clickhouse /etc/clickhouse-server/users.d/boxlite-default.xml
chmod 640 /etc/clickhouse-server/users.d/boxlite-default.xml

# What the server itself said, on the way out. systemd reports only that the
# unit did not come up, and its own log is on a host nobody can open.
dump_server_log() { tail -n 40 /var/log/clickhouse-server/clickhouse-server.err.log 2>/dev/null || true; }
trap dump_server_log ERR

systemctl enable clickhouse-server
systemctl restart clickhouse-server
# Every client call below authenticates as default, which now has a password.
# Through the environment rather than \`--password\`, which would put it in argv
# for every process on the host to read.
export CLICKHOUSE_PASSWORD="$ADMIN"
until clickhouse-client --query 'SELECT 1' >/dev/null 2>&1; do sleep 2; done

# The schema and the two accounts, applied at boot. See this file's own note:
# there is no SSM here, so this is where the reconcile lives. The tables come
# first because the grants below name them.
mkdir -p /opt/boxlite-clickhouse
printf '%s' '${SCHEMA_BASE64}' | base64 -d > /opt/boxlite-clickhouse/otel-schema.sql
clickhouse-client --multiquery < /opt/boxlite-clickhouse/otel-schema.sql

clickhouse-client --query "CREATE DATABASE IF NOT EXISTS ${database}"
# OR REPLACE rather than IF NOT EXISTS: a rotated password has to reach the
# account, and the grants below are reissued on every boot anyway.
clickhouse-client --query "CREATE USER OR REPLACE ${writerUsername} IDENTIFIED WITH sha256_hash BY '$WRITER_HASH'"
clickhouse-client --query "CREATE USER OR REPLACE ${readerUsername} IDENTIFIED WITH sha256_hash BY '$READER_HASH'"
# SHOW COLUMNS is not decoration, and neither is the absence of CREATE: the
# exporter describes a table before its first insert and creates none of them,
# so a writer without it fails on a database that is plainly there. The same
# grants the AWS reconcile makes.
clickhouse-client --query "GRANT SELECT, INSERT, SHOW COLUMNS ON ${database}.* TO ${writerUsername}"
clickhouse-client --query "GRANT SELECT, SHOW COLUMNS ON ${database}.* TO ${readerUsername}"
echo "clickhouse setup complete"
`

export const gcpClickHouseProvider =
  ({
    network,
    project,
    zone,
    appShort,
    callers,
    managed,
    dependsOn,
  }: {
    network: Extract<NetworkBinding, { cloud: 'gcp' }>
    project: string
    /**
     * A zone in the stage's region. An instance is zonal where a subnet is not,
     * and the region itself is not needed here — the zone already names it.
     */
    zone: string
    /** The app abbreviated: what the host's own identity is named from. */
    appShort: string
    /**
     * The identities admitted to the HTTP port, one entry per caller. See
     * `CLICKHOUSE_CALLERS`: this is not the identity the host runs as, which is
     * the account created below and never handed in.
     */
    callers: $util.Output<string>[]
    managed: { url: string; writerSecretArn: string; readerSecretArn: string } | null
    dependsOn: any[]
  }): ClickHouseProvider =>
  (request: ClickHouseRequest): ClickHouse => {
    if (request.mode === 'disabled') return { active: false, mode: 'disabled' }

    if (request.mode === 'managed') {
      if (!managed) {
        throw new Error(
          'CLICKHOUSE_MODE=managed needs CLICKHOUSE_URL, CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN and ' +
            'CLICKHOUSE_READER_PASSWORD_SECRET_ARN in this stage’s store',
        )
      }
      return {
        active: true,
        mode: 'managed',
        url: $util.output(managed.url),
        database: request.database,
        // Secret Manager references here rather than Secrets Manager ARNs;
        // the store holds whichever this stage's cloud uses, and the key names
        // are shared because the *idea* is. A managed endpoint's are whatever
        // was seeded, which mstage guarantees carries no version.
        writer: {
          username: request.writerUsername,
          passwordRef: $util.output(managed.writerSecretArn),
          // A pinned version name already changes when the secret rotates, so
          // there is nothing to look up: unlike an ARN, it is not stable across
          // one.
          credentialVersion: $util.output(managed.writerSecretArn),
        },
        reader: {
          username: request.readerUsername,
          passwordRef: $util.output(managed.readerSecretArn),
          credentialVersion: $util.output(managed.readerSecretArn),
        },
        // A managed endpoint admits whoever holds its credential; there is no
        // rule of ours to name anybody in, as on the AWS side.
        binding: { cloud: 'gcp', clientGrants: [] },
        id: $util.output(managed.url),
        ready: [],
      }
    }

    const admin = clickHouseSecret(
      'ClickHouseAdminSecret',
      project,
      instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse-admin' }),
    )
    const writer = clickHouseSecret(
      'ClickHouseWriterSecret',
      project,
      instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse-writer' }),
    )
    const reader = clickHouseSecret(
      'ClickHouseReaderSecret',
      project,
      instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse-reader' }),
    )

    const host = new gcp.serviceaccount.Account('ClickHouseServiceAccount', {
      project,
      accountId: identityFor({ appShort, stage: $app.stage, artifact: 'clickhouse', action: 'run' }),
      displayName: `BoxLite ClickHouse (${$app.stage})`,
    })
    // Each secret named individually rather than a project-wide accessor role:
    // the host reads exactly its own three and nothing else in the project.
    const access = [admin, writer, reader].map(
      ({ secret }, index) =>
        new gcp.secretmanager.SecretIamMember(`ClickHouseSecretAccess${index}`, {
          project,
          secretId: secret.secretId,
          role: 'roles/secretmanager.secretAccessor',
          member: host.email.apply((email: string) => `serviceAccount:${email}`),
        }),
    )

    /*
     * The data disk, separate and retained.
     *
     * Separate because the boot disk goes with the instance whenever the
     * startup script changes; retained because a stage removed by mistake must
     * keep the history it collected. The same reasoning as the AWS side's EBS
     * volume, and the same two properties.
     */
    const disk = new gcp.compute.Disk(
      'ClickHouseData',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse-data' }),
        project,
        zone,
        size: request.dataGb,
        type: DISK_TYPE,
      },
      { retainOnDelete: true },
    )

    const startupScript = $resolve([admin.version.name, writer.version.name, reader.version.name]).apply(
      ([adminRef, writerRef, readerRef]) =>
        clickHouseStartupScript({
          database: request.database,
          writerUsername: request.writerUsername,
          readerUsername: request.readerUsername,
          adminRef,
          writerRef,
          readerRef,
        }),
    )

    const instance = new gcp.compute.Instance(
      'ClickHouse',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse' }),
        project,
        zone,
        machineType: MACHINE[request.instanceSize],
        bootDisk: { initializeParams: { image: IMAGE, size: 20, type: DISK_TYPE } },
        attachedDisks: [{ source: disk.id, deviceName: 'clickhouse-data' }],
        networkInterfaces: [
          {
            subnetwork: network.subnetwork,
            // No access config, so no external address at all: the only way in
            // is from inside this network.
          },
        ],
        serviceAccount: { email: host.email, scopes: ['cloud-platform'] },
        metadataStartupScript: startupScript,
        // Telemetry storage is not a machine to be replaced casually, and a
        // newer image on an unrelated deploy would take the history with it.
        allowStoppingForUpdate: false,
      },
      { ignoreChanges: ['bootDisk'], dependsOn: [...access, ...dependsOn] },
    )

    const firewall = new gcp.compute.Firewall('ClickHouseFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse' }),
      project,
      network: network.network,
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: [String(HTTP_PORT)] }],
      // Whoever the caller is, by identity — the collector writes and the API
      // reads, and nothing else in the network has a reason to reach this. Both
      // of them, from one list: see `CLICKHOUSE_CALLERS` for what naming only
      // the writer here costs.
      sourceServiceAccounts: callers,
      targetServiceAccounts: [host.email],
    })

    return {
      active: true,
      mode: 'self-hosted',
      url: $interpolate`http://${instance.networkInterfaces[0].networkIp}:${HTTP_PORT}`,
      database: request.database,
      writer: {
        username: request.writerUsername,
        passwordRef: writer.version.name,
        credentialVersion: writer.version.name,
      },
      reader: {
        username: request.readerUsername,
        passwordRef: reader.version.name,
        credentialVersion: reader.version.name,
      },
      binding: { cloud: 'gcp', clientGrants: callers },
      id: instance.id,
      ready: [instance, firewall],
    }
  }
