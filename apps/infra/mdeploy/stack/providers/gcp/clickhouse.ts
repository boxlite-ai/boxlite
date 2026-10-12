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
 * So schema and accounts are reconciled from the *startup script*, at boot.
 * Retention alone has a second path: an OS Config policy that alters the
 * table TTLs in place, so a changed value reaches a running host without SSH,
 * a restart, or a replaced instance.
 *
 * `managed` and `disabled` behave exactly as they do on AWS, because neither
 * touches a machine.
 */

import { publishClickStack } from './clickstack.ts'
import { renderClickHouseSchema } from '../../clickhouse-host.ts'
import type { ClickHouse, ClickHouseProvider, ClickHouseRequest } from '../../clickhouse.ts'
import type { NetworkBinding } from '../../network.ts'
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
 * The OTLP schema the host applies at boot, base64 so that one quoting problem
 * cannot become two. Always rendered at the default retention: the startup
 * script replaces the VM when it changes, so the configured value must never
 * appear in it. The policy below carries that value instead.
 */
const BOOTSTRAP_SCHEMA_BASE64 = Buffer.from(renderClickHouseSchema()).toString('base64')

/**
 * The OS Config policy that keeps the seven table TTLs at the configured
 * retention. Tables and their TTL expressions come from the schema itself, so
 * the policy cannot drift from the bundled definitions.
 *
 * Compliance is judged by the `toIntervalHour(N)` marker ClickHouse prints
 * into `create_table_query` — the same check the AWS readiness command makes.
 * Matching the whole clause would tie the policy to the server's formatting,
 * and a permanent mismatch would re-run all seven ALTERs every agent cycle.
 */
export const clickHouseRetentionPolicy = (retentionHours: number, adminRef: string) => {
  const tables = [...renderClickHouseSchema(retentionHours).matchAll(
    /CREATE TABLE IF NOT EXISTS [`"]otel[`"]\.[`"](\w+)[`"].*?\bTTL ([^\n]+)/gs,
  )]
  if (tables.length !== 7) throw new Error('ClickHouse retention requires all seven telemetry tables')
  const names = tables.map(([, table]) => `'${table}'`).join(', ')
  const auth = `#!/bin/bash
set -euo pipefail
CLICKHOUSE_PASSWORD=$(gcloud secrets versions access '${adminRef}' --format='get(payload.data)' | base64 -d)
export CLICKHOUSE_PASSWORD
check_ttl() {
  clickhouse-client --receive_timeout=60 --query "SELECT count() FROM system.tables WHERE database = 'otel' AND name IN (${names}) AND position(create_table_query, 'toIntervalHour(${retentionHours})') > 0"
}
`
  return {
    validate: `${auth}count=$(check_ttl)
if [ "$count" = 7 ]; then exit 100; else exit 101; fi
`,
    enforce: `${auth}clickhouse-client --receive_timeout=60 --multiquery <<'SQL'
${tables.map(([, table, ttl]) => `ALTER TABLE otel.${table} MODIFY TTL ${ttl.trim()};`).join('\n')}
SQL
test "$(check_ttl)" = 7
exit 100
`,
  }
}

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
printf '%s' '${BOOTSTRAP_SCHEMA_BASE64}' | base64 -d > /opt/boxlite-clickhouse/otel-schema.sql
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
    region,
    zone,
    appShort,
    callerRanges,
    clickStackConsumerProject,
    clickStackConsumerAccount,
    managed,
    dependsOn,
  }: {
    network: Extract<NetworkBinding, { cloud: 'gcp' }>
    project: string
    /**
     * The stage's region: where the ClickStack publication's regional resources
     * live. The instance below does not need it — a zone already names its
     * region — but a subnet, a backend service and an attachment all do.
     */
    region: string
    /**
     * A zone in the stage's region. An instance is zonal where a subnet is not,
     * and the region itself is not needed here — the zone already names it.
     */
    zone: string
    /** The app abbreviated: what the host's own identity is named from. */
    appShort: string
    /**
     * The callers as the firewall can see them: the ranges they egress from.
     *
     * The collector writes and the API reads, and both are Cloud Run services,
     * so neither label a rule could prefer reaches them — Google attributes a
     * direct-egress packet to no account, and lists a network tag in an ingress
     * rule among what direct VPC egress does not support. One range covers both
     * because both egress from the subnet that holds nothing else; see
     * `CLOUDRUN_EGRESS_CIDR`, which is what keeps this as narrow as an identity.
     */
    callerRanges: string[]
    /**
     * The project whose endpoints may reach this ClickHouse over Private
     * Service Connect. See `publishClickStack`, which owns the publication.
     */
    clickStackConsumerProject: string
    /** The identity let read the reader password, or null to grant nobody. */
    clickStackConsumerAccount: string | null
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

    /** What the instance and the rule that guards it are both named. */
    const hostName = instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse' })

    const instance = new gcp.compute.Instance(
      'ClickHouse',
      {
        name: hostName,
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
        metadata: { 'enable-osconfig': 'TRUE' },
        labels: { 'boxlite-clickhouse': hostName },
        // Telemetry storage is not a machine to be replaced casually, and a
        // newer image on an unrelated deploy would take the history with it.
        allowStoppingForUpdate: false,
      },
      // The startup script is not ignored: a rotated password must reach the host.
      { ignoreChanges: ['bootDisk'], dependsOn: [...access, ...dependsOn] },
    )

    const firewall = new gcp.compute.Firewall('ClickHouseFirewall', {
      name: hostName,
      project,
      network: network.network,
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: [String(HTTP_PORT)] }],
      /*
       * Whoever the caller is, by the range they arrive from — the collector
       * writes and the API reads, and nothing else in the network has a reason
       * to reach this. One range names both: see `callerRanges`, and
       * `CLOUDRUN_EGRESS_CIDR` for why that range is not the workload subnet.
       *
       * By range rather than by account or tag because neither reaches a Cloud
       * Run caller: both are unsupported as the source of an ingress rule for
       * direct VPC egress, and an identity here drops the packet rather than
       * refusing it — see `CLOUDRUN_EGRESS_CIDR` for the measurement.
       */
      sourceRanges: callerRanges,
      targetServiceAccounts: [host.email],
    })

    const retention = admin.version.name.apply((ref: string) => clickHouseRetentionPolicy(request.retentionHours, ref))
    const retentionPolicy = new gcp.osconfig.OsPolicyAssignment('ClickHouseRetention', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickhouse-retention' }),
      project,
      location: zone,
      instanceFilter: { inclusionLabels: [{ labels: { 'boxlite-clickhouse': hostName } }] },
      osPolicies: [
        {
          id: 'telemetry-retention',
          mode: 'ENFORCEMENT',
          resourceGroups: [
            {
              resources: [
                {
                  id: 'table-ttl',
                  exec: {
                    validate: { interpreter: 'NONE', script: retention.apply((scripts: { validate: string }) => scripts.validate) },
                    enforce: { interpreter: 'NONE', script: retention.apply((scripts: { enforce: string }) => scripts.enforce) },
                  },
                },
              ],
            },
          ],
        },
      ],
      rollout: { disruptionBudget: { fixed: 1 }, minWaitDuration: '0s' },
    }, { dependsOn: [instance, ...access] })

    /*
     * Published to the consumer in another network, always.
     *
     * Not conditional on anything: a self-hosted ClickHouse on GCP is the only
     * source of the console's Observability panel, and the accept list — not
     * the existence of the attachment — is what decides who may connect. See
     * `clickstack.ts` for the chain from here to an endpoint.
     */
    publishClickStack({
      project,
      region,
      zone,
      network: network.network,
      subnetwork: network.subnetwork,
      instanceLink: instance.selfLink,
      hostAccount: host.email,
      port: HTTP_PORT,
      consumerProject: clickStackConsumerProject,
      consumerAccount: clickStackConsumerAccount,
      readerSecretId: reader.secret.secretId,
      dependsOn: [instance],
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
      id: instance.id,
      ready: [instance, firewall, retentionPolicy],
    }
  }
