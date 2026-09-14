/*
 * The GCP settings that are wrong silently, or wrong only once a deploy runs.
 *
 * Every one of these was a real refusal or a real silence on the way to the
 * first applied GCP stage, and every one of them shares a shape: the value that
 * fails is the value nobody wrote down. An edition the API picks, a `PORT` the
 * platform reserves, an invoker a load balancer cannot present, a resource kind
 * an alarm did not have to name, a disk family a machine no longer takes.
 *
 * Almost none of these providers can be instantiated here — they build Pulumi
 * resources — so what runs is the pieces that decide those values: the two
 * machine tables, the alert policy's filter, and the API environment, which is
 * a pure function of the stage's configuration. The one that cannot be reached
 * that way is read out of its own source, because the pairing it has to keep is
 * between two lines of one file.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apiEnvironmentFrom } from '../src/api-environment.ts'
import { alertPolicyFilter } from '../stack/providers/gcp/alarms.ts'
import { renderClickHouseSchema } from '../../scripts/clickhouse-host.js'
import {
  DISK_TYPE as CLICKHOUSE_DISK,
  MACHINE as CLICKHOUSE_MACHINE,
  clickHouseStartupScript,
} from '../stack/providers/gcp/clickhouse.ts'
import { MACHINE as DATABASE_MACHINE } from '../stack/providers/gcp/database.ts'
import { gcpStackProviders } from '../stack/providers/gcp/index.ts'
import {
  GKE_POD_CIDR,
  GKE_SERVICE_CIDR,
  MANAGED_PROXY_CIDR,
  PSC_NAT_CIDR,
  SUBNET_CIDR,
} from '../stack/providers/gcp/network.ts'
import { BOOT_DISK_TYPE, MACHINE as RUNNER_MACHINE } from '../stack/providers/gcp/runners.ts'
import { PROXY_API_KEY_FILE, secretProviderParameters } from '../stack/providers/gcp/edge.ts'
import { instanceFor } from 'naming'

/*
 * The committed example, not this machine's stage file.
 *
 * Building a bundle resolves every image address, and `awsImages`/`gcpImages`
 * default to `loadBuildConfig()`, which reads `.mstage.config.json` — a file
 * a fresh checkout and every runner are without. Assigned rather than passed
 * because the bundle factories take no environment: they are the deploy's own
 * composition, and a stage file is what a deploy has. `??=` so a caller that
 * already named one still wins.
 */
process.env.MSTAGE_CONFIG ??= fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const sourceOf = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../stack/providers/gcp/${module}.ts`, import.meta.url)), 'utf8')

/**
 * The bundle, which creates no resource: every entry is a function from the
 * modules it depends on to a provider. Building one is what runs the wiring
 * that decides which identities each module is handed.
 */
const gcpBundle = () =>
  gcpStackProviders({
    stage: 'dev2',
    region: 'asia-southeast1',
    project: 'boxlite-dev2',
    appShort: 'bl-app',
    domain: 'dev2.boxlite.ai',
    zoneId: 'zone-1',
    artifactsBucket: 'boxlite-app-dev2-artifacts-boxlite-dev2',
  })

// ── the container's port ────────────────────────────────────────────────────

const DECLARATION = { groups: { deploy: [], api: [] }, where: '/repo/mstage.config.json' }

const apiEnvironment = (home: 'aws' | 'gcp') =>
  apiEnvironmentFrom({
    environment: { STACK_DOMAIN: 'dev2.boxlite.ai', OIDC_ISSUER_BASE_URL: 'https://auth.dev2.boxlite.ai' },
    declaration: DECLARATION,
    region: 'asia-southeast1',
    stage: 'dev2',
    home,
  }).environment

test('a GCP stage does not declare PORT, which Cloud Run reserves', () => {
  /*
   * `template.containers[0].env: The following reserved env names were
   * provided: PORT` — a 400 before a single resource is created. Cloud Run sets
   * the variable itself from the container port the service declares, so the
   * application still gets it; only the channel differs.
   */
  assert.equal('PORT' in apiEnvironment('gcp'), false)
})

test('an AWS stage still declares it, because ECS reserves nothing', () => {
  // The other half. Dropping it everywhere would leave the task with no way to
  // learn its port — the same outage, arrived at by fixing the first one.
  assert.equal(apiEnvironment('aws').PORT, '3000')
})

test('the API is told to apply its own schema, as the incumbent stack tells it', () => {
  /*
   * `stack/api.ts` — the path that deploys today — sets this unconditionally.
   * The port dropped it, which changes nothing against a database that already
   * has a schema and is fatal against one that does not: the first deploy of a
   * new stage connects and exits on `42P01 undefined_table`, with every
   * resource created and nothing in the deploy having failed.
   */
  for (const home of ['aws', 'gcp'] as const) {
    assert.equal(apiEnvironment(home).RUN_MIGRATIONS, 'true', `${home} deploys an unmigrated database`)
  }
})

// ── who may invoke the control plane ────────────────────────────────────────

test('the API is invocable by the load balancer, which carries no identity', () => {
  /*
   * Cloud Run checks IAM on every request and a serverless NEG signs as nobody,
   * so named invokers authorise the proxy and the runner and authorise nothing
   * for the path a browser takes. Without this the whole control plane answers
   * 403 through its own domain while every service account can still reach it.
   */
  assert.match(sourceOf('api'), /member: 'allUsers'/)
})

test('and the ingress is what restricts it, which is the other half of that pair', () => {
  /*
   * The guard the comment beside `allUsers` asks for. Widening the ingress next
   * to a public invoker is a one-word edit that publishes the control plane, and
   * it is not a change any type or apply would object to.
   */
  const source = sourceOf('api')
  const ingress = /ingress: '([A-Z_]+)'/.exec(source)?.[1]
  assert.ok(ingress, 'the API declares no ingress at all')
  assert.ok(
    ['INGRESS_TRAFFIC_INTERNAL_ONLY', 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER'].includes(ingress),
    `allUsers may invoke the API and its ingress is ${ingress}; that pair is a public control plane`,
  )
})

test('the control plane answers on api.<domain>, the name everything is configured with', () => {
  /*
   * `DASHBOARD_BASE_API_URL` defaults to `https://api.<domain>` and the SDKs are
   * configured with the same name, so a balancer serving only the root domain
   * deploys green and cannot be called. Both clouds compose it the same way;
   * this holds the GCP side to the string the environment already derives.
   */
  const derived = apiEnvironment('gcp').DASHBOARD_BASE_API_URL
  assert.equal(derived, 'https://api.dev2.boxlite.ai')

  const source = sourceOf('api')
  assert.match(source, /const apiHost = `api\.\$\{domain\}`/)
  // Serving the name is two things, and one without the other is still broken:
  // a certificate that does not cover it fails the handshake, and a record that
  // does not exist holds the whole certificate in FAILED_NOT_VISIBLE.
  assert.match(source, /managed: \{ domains: \[domain, apiHost\] \}/)
  assert.match(source, /name: apiHost/)
  // And `address` is what the proxy and the runner call, so it is the API's
  // hostname rather than the dashboard's.
  assert.match(source, /address: \$util\.output\(`https:\/\/\$\{apiHost\}`\)/)
})

test('the collector is invocable from the network, and the ingress is the whole restriction', () => {
  /*
   * The pair that replaced per-caller IAM. OTLP carries no credential, so
   * authorising by caller meant every sender minting a Google ID token for this
   * service's address — one implementation per language, for a service whose
   * ingress already admits nothing from outside the VPC. The AWS side puts the
   * same collector behind an internal load balancer that authorises nobody.
   *
   * `allUsers` is therefore correct here *only* while the ingress stays
   * internal: widening that one word publishes an open telemetry sink, and no
   * type or apply would object.
   */
  const source = sourceOf('collector')
  assert.match(source, /member: 'allUsers'/)
  assert.match(source, /ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY'/)
  // And nothing mints tokens for it any more.
  assert.equal(/GOOGLE_ID_TOKEN/.test(sourceOf('runners') + sourceOf('edge')), false)
})

test('the telemetry database admits every identity that speaks to it, not just the writer', () => {
  /*
   * The collector writes and the API reads, and the rule is keyed on service
   * accounts — so an identity left out of it is *dropped* rather than refused:
   * the reader gets a connect timeout against a database that is plainly
   * running, ClickHouse logs nothing because nothing arrived, and the explicit
   * deny at 65534 is the only trace. The composition root used to hand over the
   * collector's account alone while the comment beside it said both, and no
   * stage caught it because the one GCP stage keeps `CLICKHOUSE_MODE=disabled`.
   *
   * The roles are recorded as the bundle asks the network for them, so this
   * fails when the wiring stops asking rather than when a string moves.
   */
  const asked: string[] = []
  const network = {
    binding: { cloud: 'gcp', network: 'net', subnetwork: 'subnet' },
    placementFor: (role: string) => {
      asked.push(role)
      return { cloud: 'gcp', serviceAccount: `${role}@example.iam.gserviceaccount.com` }
    },
    ready: [],
  } as any
  gcpBundle().clickhouse({ network })
  assert.deepEqual([...asked].sort(), ['api', 'otel-collector'])
  // And the rule is keyed on the whole list it was handed rather than one of it.
  assert.match(sourceOf('clickhouse'), /sourceServiceAccounts: callers/)
})

/** The script as a host gets it, with three secret versions already resolved. */
const startupScript = () =>
  clickHouseStartupScript({
    database: 'otel',
    writerUsername: 'otel_writer',
    readerUsername: 'otel_reader',
    adminRef: 'projects/p/secrets/admin/versions/1',
    writerRef: 'projects/p/secrets/writer/versions/1',
    readerRef: 'projects/p/secrets/reader/versions/1',
  })

test('the host creates the tables, because the exporter creates none', () => {
  /*
   * `create_schema` is false in `apps/otel-collector/config.yaml`, and the AWS
   * side applies `clickhouse/otel-schema-v0.144.0.sql` over SSM. A GCP host that
   * created only the database and the two accounts answers every insert with
   * `UNKNOWN_TABLE`, while the instance, the firewall and the deploy all look
   * healthy and the collector retries the same batch forever.
   */
  const script = startupScript()
  const embedded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)
  assert.ok(embedded, 'the startup script carries no schema at all')
  assert.equal(Buffer.from(embedded[1], 'base64').toString('utf8'), renderClickHouseSchema())
  assert.ok(
    script.indexOf('otel-schema.sql') < script.indexOf('GRANT SELECT, INSERT'),
    'the grants name tables the host has not created yet',
  )
})

test('the writer is granted SHOW COLUMNS, which the exporter needs before its first insert', () => {
  /*
   * The exporter describes a table before writing to it, so a writer with
   * INSERT alone fails against a database that is plainly there — which is why
   * the AWS reconcile grants this and then checks the grant. `CREATE` is the
   * other half: the host owns the schema now, so nothing else is given it.
   */
  const script = startupScript()
  assert.match(script, /GRANT SELECT, INSERT, SHOW COLUMNS ON otel\.\* TO otel_writer/)
  assert.match(script, /GRANT SELECT, SHOW COLUMNS ON otel\.\* TO otel_reader/)
  assert.equal(/GRANT[^\n]*\bCREATE\b/.test(script), false, 'a writer that creates nothing needs no CREATE')
})

test('the boot script survives a second boot, and reports where someone can read it', () => {
  /*
   * The first host on this stage died two seconds in with `exit status 2`, and
   * the reason was unreadable: every line went to a file on a host nobody can
   * open — OS Login refuses accounts outside the instance's organization, which
   * is the same refusal that stops `UpgradeRunnerBinary`. `gpg` answers an
   * existing keyring with that same status, so a reset would have reproduced it
   * forever; the dpkg lock the image holds on its own first boot is the other
   * thing both the runner's boot script and the AWS host's user data wait out.
   */
  const script = startupScript()
  assert.match(script, /exec > >\(tee \/var\/log\/clickhouse-setup\.log\) 2>&1/)
  assert.match(script, /while fuser \/var\/lib\/dpkg\/lock-frontend/)
  assert.match(script, /gpg --dearmor --yes/)
  assert.match(script, /curl -fsSL --retry 5 --retry-all-errors/)
  // The key's real address. `deb/pubkey.gpg` answers 404, and `curl -f` piping
  // nothing into gpg is exactly the `exit status 2` the first host reported.
  assert.match(script, /https:\/\/packages\.clickhouse\.com\/rpm\/lts\/repodata\/repomd\.xml\.key/)
  assert.equal(/curl[^\n]*deb\/pubkey\.gpg/.test(script), false, 'the dead key path is fetched again')
  // The console it now writes to is readable by anyone who can fetch the serial
  // port, and two account passwords pass through clickhouse-client's argv.
  assert.equal(/^set -x/m.test(script), false, 'tracing this script publishes both passwords')
})

test('no password reaches a statement, because the console now reads every failed one', () => {
  /*
   * Two failures, one shape. `ALTER USER default` is refused outright — that
   * account lives in users.xml, whose storage is read-only — and ClickHouse
   * reports the refusal by echoing the statement, password and all, onto the
   * serial console this script now writes to. So the default account's password
   * goes into users.d as a hash before the first start, the two SQL accounts are
   * identified by hash, and the admin password reaches the client through the
   * environment rather than argv.
   */
  const script = startupScript()
  assert.match(script, /<password_sha256_hex>\$ADMIN_HASH<\/password_sha256_hex>/)
  assert.match(script, /IDENTIFIED WITH sha256_hash BY '\$WRITER_HASH'/)
  assert.match(script, /export CLICKHOUSE_PASSWORD="\$ADMIN"/)
  // Commands only: the comments above each of these name what they avoid.
  assert.equal(/^[^#\n]*IDENTIFIED BY '/m.test(script), false, 'a password in a statement that gets echoed')
  assert.equal(/^[^#\n]*ALTER USER default/m.test(script), false, 'users_xml refuses this, every time')
  assert.equal(/^[^#\n]*--password/m.test(script), false, 'argv is readable by every process on the host')
})

test('the hosts may read the staged binary, and only while one is being installed', () => {
  /*
   * A release comes over public HTTPS and needs no grant; a staged object is
   * read with the host's own service account, so a deploy that installs one has
   * to bind it. Scoped to the prefix for the same reason the AWS policy names
   * `<bucket>/runner/*` rather than the bucket: that bucket is not the runner's
   * to read the rest of.
   *
   * Read out of the source because building the provider would create
   * resources. What has to stay paired is the guard and the binding beside it —
   * a binding attached unconditionally would fail the apply of every stage that
   * has never staged an object, since the bucket it names may not exist yet.
   */
  const source = sourceOf('runners')
  assert.match(source, /request\.binary\.transport === 'gcs'/)
  assert.match(source, /role: 'roles\/storage\.objectViewer'/)
  assert.match(source, /resource\.name\.startsWith\("projects\/_\/buckets\/\$\{artifactsBucket\}\/objects\/runner\/"\)/)
  // And the host waits for it: a boot script that fetched before the binding
  // existed would download nothing, and that boot never happens again.
  assert.match(source, /dependsOn: \[\.\.\.dependsOn, \.\.\.staged\]/)
})

test('the upgrade policy selects hosts by the label those hosts actually carry', () => {
  /*
   * An assignment whose filter matches nothing is a fleet that silently never
   * upgrades — no error anywhere, because "no VM matched" is a valid policy.
   * The instance and the filter therefore read one constant, and this is what
   * keeps a second spelling from being introduced beside it.
   */
  const source = sourceOf('runners')
  assert.match(source, /const RUNNER_LABEL = 'boxlite-runner'/)
  assert.equal(
    source.match(/\[RUNNER_LABEL\]: runnerLabelValue\(/g)?.length,
    2,
    'the label is spelled once for the instance and once for the filter, or they can drift',
  )
  // ENFORCEMENT, not VALIDATION: a policy that only reports would leave the
  // fleet on the old binary while every report said "non-compliant".
  assert.match(source, /mode: 'ENFORCEMENT'/)

  /*
   * And the hosts ask for the agent themselves. `enable-osconfig=PER-VM` is what
   * a project carries when VM Manager is turned on for it, and it means no
   * instance runs the agent unless its own metadata says TRUE — a fleet trusting
   * the project-wide value reports no inventory and the policy reaches nobody.
   */
  assert.match(source, /'enable-osconfig': 'TRUE'/)

  // And the scripts run as files, not through /bin/sh: see the shebang test in
  // `runner-upgrade.test.ts` for what dash does to the payload's first line.
  assert.equal(/interpreter: 'SHELL'/.test(source), false, 'SHELL is dash here, and the payload is bash')
  assert.equal(source.match(/interpreter: 'NONE'/g)?.length, 2, 'both scripts have to be run directly')
})

test('the proxy Pods are denied by default, and the engine that enforces it is on', () => {
  /*
   * A NetworkPolicy on a cluster with no policy engine is accepted by the API
   * server and enforced by nothing — the manifest would claim a boundary the
   * cluster does not have. The two therefore have to be asserted together.
   *
   * Read out of the source because building the provider creates resources.
   */
  const cluster = sourceOf('cluster')
  assert.match(cluster, /datapathProvider: 'ADVANCED_DATAPATH'/, 'no policy engine, so no policy is enforced')

  const edge = sourceOf('edge')
  assert.match(edge, /name: 'default-deny'/)
  assert.match(edge, /policyTypes: \['Ingress', 'Egress'\]/)
  // Egress is the half that matters for a proxy: its job is opening connections
  // for a caller, so an unbounded one is a tunnel into the VPC.
  for (const destination of [/169\.254\.169\.254\/32/, /SUBNET_CIDR/, /port: 443/]) {
    assert.match(edge, destination)
  }
})

test('a Pod outlives the window its endpoint is drained for', () => {
  /*
   * Three timeouts in a row, and the kubelet's has to be the longest: a Pod
   * SIGKILLed at 3600s is one the balancer still believes it is draining, and
   * the connections it was holding are cut rather than finished.
   */
  const edge = sourceOf('edge')
  const grace = Number(/terminationGracePeriodSeconds: ([\d_]+)/.exec(edge)?.[1]?.replace(/_/g, ''))
  const draining = Number(/connectionDrainingTimeoutSec: ([\d_]+)/.exec(edge)?.[1]?.replace(/_/g, ''))
  assert.ok(Number.isFinite(grace) && Number.isFinite(draining), 'both timeouts must be stated')
  assert.ok(grace > draining, `grace ${grace}s must outlast draining ${draining}s`)
})

// ── the database's machine ──────────────────────────────────────────────────

test('every Cloud SQL size names its edition beside its tier', () => {
  /*
   * `Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition`. A PostgreSQL 16
   * instance defaults to ENTERPRISE_PLUS, which takes only the predefined
   * `db-perf-optimized-N-*` machines — so a shared-core or custom tier with the
   * edition left unset is refused at create time, every time.
   */
  for (const [size, machine] of Object.entries(DATABASE_MACHINE)) {
    assert.ok(machine.edition, `${size} leaves the edition to the API`)
    const predefined = machine.tier.startsWith('db-perf-optimized-')
    assert.equal(
      machine.edition,
      predefined ? 'ENTERPRISE_PLUS' : 'ENTERPRISE',
      `${size} pairs ${machine.tier} with ${machine.edition}`,
    )
  }
})

test('the instance is told to log connections, so a silent Postgres means something', () => {
  /*
   * Cloud SQL terminates TLS at the instance front end, so a failed handshake
   * never reaches Postgres — and with `log_connections` off, *nothing logged*
   * and *nothing arrived* are the same observation. This is the flag that lets
   * a reachability question be answered rather than guessed at.
   */
  assert.match(sourceOf('database'), /name: 'log_connections', value: 'on'/)
})

test('the instance opens the private path Google-managed callers take', () => {
  // Without it `/cloudsql/<instance>` is a socket that exists and accepts
  // nothing: mounting is not a route.
  assert.match(sourceOf('database'), /enablePrivatePathForGoogleCloudServices: true/)
})

test('a GCP workload reaches Cloud SQL through the platform’s proxy, not the address', () => {
  /*
   * The address is reachable and connecting to it still fails: Cloud SQL signs
   * with a CA of its own per instance, `sslMode` refuses an unencrypted client,
   * and the image trusts the public roots — so `pg` gets
   * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and the container never passes its
   * startup probe. The proxy needs no certificate of ours.
   */
  const database = sourceOf('database')
  assert.match(
    database,
    /host: instance\.connectionName\.apply\(\(connection: string\) => `\/cloudsql\/\$\{connection\}`\)/,
  )
  assert.match(database, /applicationTls: false/)

  // And the mount, whose name the platform reserves: anything else is refused
  // with `Cloud SQL volume must be named 'cloudsql'`.
  const api = sourceOf('api')
  assert.match(api, /const CLOUD_SQL_VOLUME = 'cloudsql'/)
  assert.match(api, /cloudSqlInstance: \{ instances: \[/)
  assert.match(api, /\{ name: CLOUD_SQL_VOLUME, mountPath: `\/\$\{CLOUD_SQL_VOLUME\}` \}/)
})

test('the cache is reached on the port the instance reports, not Redis’s default', () => {
  /*
   * Memorystore moves the listener when transit encryption is on: a
   * `SERVER_AUTHENTICATION` instance serves 6378 and nothing is bound to 6379.
   * A client dialling the constant gets a connect timeout rather than a
   * refusal, which reads as a firewall or a peering fault and sends the reader
   * to the network — the API crash-looped on `connect ETIMEDOUT` for exactly
   * this reason, with a healthy instance one hop away.
   */
  const source = sourceOf('cache')
  assert.match(source, /port: instance\.port\.apply\(String\)/)
  assert.equal(/const PORT = '6379'/.test(source), false, 'the port is still a constant')
})

// ── the runner's machine ────────────────────────────────────────────────────

test('every runner size is a family that can nest, and none is one that cannot', () => {
  // A host on a family without nested virtualization boots, registers, and fails
  // every box on a missing `/dev/kvm` — which reads as a runner bug.
  const cannotNest = [/^e2-/, /^t2a-/, /^m[1-4]-/, /^n2d-/, /^c2d-/]
  for (const [size, machine] of Object.entries(RUNNER_MACHINE)) {
    for (const family of cannotNest) {
      assert.equal(family.test(machine), false, `${size} is ${machine}, which cannot nest`)
    }
  }
})

test('the boot disk is the one N4 attaches, and no Persistent Disk is asked for', () => {
  // N4 does not take Persistent Disk at all, so `pd-balanced` is a create-time
  // refusal rather than a slower disk.
  assert.equal(BOOT_DISK_TYPE, 'hyperdisk-balanced')
  assert.equal(sourceOf('runners').includes("'pd-"), false)
})

test('every GCE host in the bundle names a machine family and a disk that pair', () => {
  /*
   * Both machines the AWS side runs on EC2 — the runner fleet and the
   * self-hosted ClickHouse — and the pairing is the thing: an N4 with a
   * `pd-balanced` disk is refused at create time, and the refusal names the
   * disk rather than the family that cannot take it.
   */
  const hosts = [
    { module: 'runners', machines: Object.values(RUNNER_MACHINE), disk: BOOT_DISK_TYPE },
    { module: 'clickhouse', machines: Object.values(CLICKHOUSE_MACHINE), disk: CLICKHOUSE_DISK },
  ]
  for (const { module, machines, disk } of hosts) {
    for (const machine of machines) {
      assert.ok(machine.startsWith('n4-'), `${module} asks for ${machine}`)
    }
    assert.equal(disk, 'hyperdisk-balanced', `${module} pairs N4 with ${disk}`)
    assert.equal(sourceOf(module).includes("type: 'pd-"), false, `${module} still names a Persistent Disk`)
  }
})

test('no minCpuPlatform is asked of a family that has exactly one', () => {
  // The floor N2 needed. On N4 naming an older platform is rejected rather than
  // read as a minimum already met. The argument, not the prose: the comment
  // above `BOOT_DISK_TYPE` says why it is gone, and should keep saying so.
  assert.equal(/^\s*minCpuPlatform:/m.test(sourceOf('runners')), false)
})

// ── what a container may read ───────────────────────────────────────────────

test('a Cloud Run workload is granted every secret it is handed, from one list', () => {
  /*
   * The two lists have to be one. When they were two, the capability list
   * granted what a capability named and the container's environment was given
   * the database and cache passwords beside it — so the API was handed two
   * references its service account had never been allowed to resolve. Cloud Run
   * refuses that create outright: `Permission denied on secret:
   * …-cache-password`, ninety seconds into an apply.
   */
  for (const module of ['api', 'collector']) {
    const source = sourceOf(module)
    assert.match(source, /addresses: Record<string, \$util\.Input<string>> = \{/, `${module} has no one list`)
    assert.match(source, /role: 'roles\/secretmanager\.secretAccessor'/, module)
    // And the service waits for them: a binding that lands after the revision
    // is a binding that lands after the refusal.
    assert.match(source, /\.\.\.readable\]/, `${module}'s service does not depend on its grants`)
  }

  /*
   * The API is handed one more by a second channel — the cache's CA, as a
   * mounted file — and Cloud Run resolves a mount as strictly as an env
   * reference. Deriving the grants from the env list alone missed it and the
   * revision was refused with `Permission denied on secret: …-cache-ca`, so the
   * list the grants come from has to span both channels.
   */
  const api = sourceOf('api')
  assert.match(api, /handedOver: Record<string, \$util\.Input<string>> = \{\n\s+\.\.\.addresses,/)
  assert.match(api, /\[CACHE_CA_VOLUME\]: onGcpCache\(dependencies\.cache\)\.caRef,/)
  assert.match(api, /Object\.keys\(handedOver\)\.map\(/)
  assert.match(sourceOf('collector'), /Object\.keys\(addresses\)\.map\(/)
})

// ── the proxy's host ────────────────────────────────────────────────────────

test('the firewall attaches to the network it was handed, not one cut out of a subnetwork', () => {
  /*
   * It used to recover the network by stripping `/regions/…` off the subnetwork
   * id, which leaves `projects/<project>` — and Compute reads the last segment
   * as the network's name, so the rule was refused for a network named after
   * the project (`The resource 'projects/…/global/networks/<project>' was not
   * found`). The binding already carries the self link.
   */
  const source = sourceOf('edge')
  assert.equal(/subnetwork\.replace\(/.test(source), false, 'the network is still derived by string surgery')
  assert.match(source, /^\s+network,$/m)
  assert.match(sourceOf('index'), /network: binding\(network\)\.network/)
})

test('the proxy is a GKE Deployment and no VM proxy host remains', () => {
  const edge = sourceOf('edge')
  assert.match(edge, /new kubernetes\.apps\.v1\.Deployment\(/)
  assert.match(edge, /new kubernetes\.core\.v1\.Service\(/)
  assert.equal(/new gcp\.compute\.(?:InstanceTemplate|RegionInstanceGroupManager)\(/.test(edge), false)

  const cluster = sourceOf('cluster')
  assert.match(cluster, /new gcp\.container\.Cluster\(/)
  // Autopilot owns the nodes, so there is no pool of ours to assert — the
  // guarantee moved to the flag that makes Google provision them.
  assert.match(cluster, /enableAutopilot: true/)
  assert.equal(/new gcp\.container\.NodePool\(/.test(cluster), false, 'a pool beside Autopilot is not a thing')
})

test('the box proxy is fronted by a certificate the deploy provisions', () => {
  /*
   * The edge was a genuine layer-4 passthrough, on the premise that the proxy
   * terminates TLS to read the SNI name. It does not: it routes on the Host
   * header (`parseHost` in `apps/proxy/pkg/proxy/get_box_target.go`), and the
   * AWS side terminates too — `listen: '443/tls'` is a terminating NLB
   * listener. Meanwhile nothing in `apps/proxy` can obtain a certificate; it
   * serves `TLS_CERT_FILE`/`TLS_KEY_FILE` and has no ACME client. So a
   * passthrough shipped an edge where every box hostname failed its handshake,
   * and nothing in the deploy said so.
   */
  const source = sourceOf('edge')
  assert.match(source, /new gcp\.compute\.TargetSSLProxy\(/, 'the balancer does not terminate')
  assert.match(source, /new gcp\.certificatemanager\.Certificate\(/, 'no certificate is provisioned')
  // The wildcard is the whole point: one certificate for every box that will
  // ever exist, which on this cloud needs Certificate Manager and a DNS
  // authorization — the load balancer's own managed certificate cannot hold one.
  assert.match(source, /domains: \[request\.domain, `\*\.\$\{request\.domain\}`\]/)
  assert.match(source, /new gcp\.certificatemanager\.DnsAuthorization\(/)
  assert.match(source, /dnsResourceRecords\[0\]/, 'the challenge record is never published')
  assert.equal(/loadBalancingScheme: 'EXTERNAL'[,\s]/.test(source), false, 'still a passthrough scheme')
})

test('the proxy hosts admit the balancer and not the internet', () => {
  // A passthrough forwarded the client's own connection, so the rule was 443
  // from anywhere. A proxy balancer connects from Google's front ends to the
  // container's port, so leaving the old rule would be a host open to the world
  // on a port nothing should reach directly.
  const source = sourceOf('edge')
  assert.match(source, /const LOAD_BALANCER_RANGES = \['130\.211\.0\.0\/22', '35\.191\.0\.0\/16'\]/)
  assert.match(source, /sourceRanges: LOAD_BALANCER_RANGES/)
  assert.match(source, /targetServiceAccounts: \[host\.nodeServiceAccount\]/)
  assert.equal(source.includes("sourceRanges: ['0.0.0.0/0']"), false)
})

test('the GKE nodes may read the registry, without granting that role to the workload', () => {
  const cluster = sourceOf('cluster')
  assert.match(cluster, /role: 'roles\/artifactregistry\.reader'/)
  assert.match(cluster, /serviceAccount: nodeAccount\.email/)
  assert.equal(/roles\/artifactregistry\.reader/.test(sourceOf('edge')), false)
})

test('the cluster enables managed Secret Manager CSI and Workload Identity', () => {
  const source = sourceOf('cluster')
  assert.match(source, /workloadIdentityConfig: \{ workloadPool: `\$\{project\}\.svc\.id\.goog` \}/)
  assert.match(source, /secretManagerConfig: \{ enabled: true \}/)
  // The metadata server is Autopilot's own default; what still has to be said
  // is which identity its nodes run as, or they fall back to the project's
  // default Compute account.
  assert.match(source, /autoProvisioningDefaults: \{\s*serviceAccount: nodeAccount\.email/)
  assert.match(source, /enablePrivateNodes: true/)
})

test('the proxy key is a CSI file, never a Kubernetes Secret or secret-valued env entry', () => {
  const source = sourceOf('edge')
  assert.match(source, /kind: 'SecretProviderClass'/)
  assert.match(source, /provider: 'gke'/)
  assert.match(source, /driver: 'secrets-store-gke\.csi\.k8s\.io'/)
  assert.match(source, /delete plainEnvironment\[PROXY_API_KEY\]/)
  assert.equal(/kubernetes\.core\.v1\.Secret/.test(source), false)
  assert.equal(PROXY_API_KEY_FILE, '/var/run/secrets/boxlite/proxy-api-key')
  assert.deepEqual(JSON.parse(secretProviderParameters('projects/p/secrets/proxy/versions/7')), [
    { resourceName: 'projects/p/secrets/proxy/versions/7', path: 'proxy-api-key' },
  ])
})

test('the Kubernetes identity maps to the existing proxy GSA and gets only secret access', () => {
  const source = sourceOf('edge')
  assert.match(source, /'iam\.gke\.io\/gcp-service-account': placement\.serviceAccount/)
  assert.match(source, /role: 'roles\/iam\.workloadIdentityUser'/)
  assert.match(source, /role: 'roles\/secretmanager\.secretAccessor'/)
  assert.match(source, /secretId: coordinates\.apply/)
})

test('the workload identity binding waits for the cluster whose pool it names', () => {
  /*
   * `<project>.svc.id.goog` does not exist until a cluster with Workload
   * Identity has been created, and the member naming it is a plain string, so
   * nothing in the argument list orders the two — the binding would otherwise
   * be granted while the cluster is still being created, and the API refuses
   * the whole policy with `Identity Pool does not exist`.
   *
   * Bounded to this resource: the dependency has to be on the binding rather
   * than merely somewhere in the file, so the match may not cross into the
   * next `new gcp.` construction.
   */
  assert.match(
    sourceOf('edge'),
    /'ProxyWorkloadIdentity',(?:(?!new gcp\.)[\s\S])*?\{ dependsOn: host\.ready \}/,
  )
})

test('the standalone NEG exists before the old load balancer backend is switched', () => {
  const source = sourceOf('edge')
  assert.match(source, /'cloud\.google\.com\/neg'/)
  assert.match(source, /'pulumi\.com\/skipAwait': 'true'/)
  assert.match(source, /dependsOn: \[\s*service,/)
  assert.match(source, /getNetworkEndpointGroupOutput\([\s\S]*dependsOn: \[deployment\]/)
  // One backend per zone: a regional Autopilot cluster puts Pods wherever the
  // region has room, and a single-zone backend list would leave the rest
  // unreachable with every health check still green.
  assert.match(source, /backends: negLinks\.apply\(/)
  assert.match(source, /links\.map\(\(group\) => \(\{/)
  assert.match(source, /balancingMode: 'CONNECTION'/)
})

test('GKE Pod addresses, not the workload GSA, are admitted to runners', () => {
  const edge = sourceOf('edge')
  assert.match(edge, /new gcp\.compute\.Firewall\('ProxyToRunnerFirewall'/)
  assert.match(edge, /sourceRanges: \[GKE_POD_CIDR\]/)
  assert.match(edge, /targetServiceAccounts: \[runnerServiceAccount\]/)
  assert.equal(/sourceServiceAccounts: \[accounts\.api\.email, accounts\.proxy\.email\]/.test(sourceOf('network')), false)
})

// ── what an alarm watches ───────────────────────────────────────────────────

test('an alert policy names the kind its own metric comes from', () => {
  /*
   * Both halves are load-bearing. Monitoring refuses a condition with no
   * `resource.type` at all (`must specify a restriction on "resource.type"`, a
   * 400), and a condition naming the wrong kind is accepted and matches
   * nothing — which is what a hardcoded `cloud_run_revision` did to the proxy
   * alarm, whose metric counts health transitions for a standalone NEG.
   */
  assert.equal(
    alertPolicyFilter({ metricName: 'boxlite-dev2-proxy-unhealthy', resourceType: 'gce_network_endpoint_group' }),
    'metric.type="logging.googleapis.com/user/boxlite-dev2-proxy-unhealthy" AND resource.type="gce_network_endpoint_group"',
  )
})

test('an alarm names its logging resource and its monitoring resource separately', () => {
  const source = sourceOf('alarms')
  assert.match(source, /const CLOUD_RUN = \{ logging: 'cloud_run_revision', monitoring: 'cloud_run_revision' \}/)
  assert.match(source, /logging: 'gce_network_endpoint_group'/)
  assert.match(source, /monitoring: 'gce_network_endpoint_group'/)
  // The policy reads the monitoring half and the metric the logging half.
  assert.match(source, /resourceType: resourceType\.monitoring/)
  assert.match(source, /resource\.labels\.network_endpoint_group_id/)
  assert.match(source, /healthCheckProbeResult\.healthState="UNHEALTHY"/)
  assert.match(sourceOf('edge'), /logConfig: \{ enable: true \}/)
  assert.equal(/resourceType: '/.test(source), false, 'an alarm names a resource kind as a bare literal')
})

/** A CIDR as the two numbers that decide whether two of them can overlap. */
const rangeOf = (cidr: string): { first: number; last: number } => {
  const [address, width] = cidr.split('/')
  const first = address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
  return { first, last: first + 2 ** (32 - Number(width)) - 1 }
}

test('the fixed GKE and proxy ranges neither overlap nor collide with Private Service Access', () => {
  /*
   * The internal balancer's Envoys need a subnet of their own, and the range it
   * takes is the one thing about it nobody can see fail in review: the Private
   * Service Access range beside it is a `/16` *Google* allocates, with no
   * address written down anywhere in this repository.
   *
   * What makes a fixed range safe is not luck. Service networking cannot hand
   * out a range overlapping a subnet of the network it peers with, so the only
   * `/16` it can never pick is the one the workload subnet already sits in —
   * and a proxy range inside that `/16` is therefore unreachable by the
   * allocator. Moving either constant out of that `/16`, or letting the two
   * subnets overlap, breaks the argument silently and the deploy months later.
   */
  const cidrs = [SUBNET_CIDR, MANAGED_PROXY_CIDR, PSC_NAT_CIDR, GKE_POD_CIDR, GKE_SERVICE_CIDR]
  for (const [index, leftCidr] of cidrs.entries()) {
    for (const rightCidr of cidrs.slice(index + 1)) {
      const left = rangeOf(leftCidr)
      const right = rangeOf(rightCidr)
      assert.ok(left.last < right.first || right.last < left.first, `${leftCidr} overlaps ${rightCidr}`)
    }
  }
  const slash16 = (cidr: string) => Math.floor(rangeOf(cidr).first / 2 ** 16)
  for (const cidr of cidrs.slice(1)) {
    assert.equal(
      slash16(cidr),
      slash16(SUBNET_CIDR),
      `${cidr} sits in a /16 the workload subnet does not block, so the allocator may take it`,
    )
  }
})

test('the ClickStack publication is named what the console looks for', () => {
  /*
   * Two repositories meet at a string. Backoffice's preflight composes
   * `<app>-<stage>-clickstack` itself and describes whatever answers to it —
   * nothing is handed over, and absence is read as "not published yet". So
   * respelling this attachment fails no deploy here: it silently leaves the
   * console's Observability panel with no data source.
   */
  const source = sourceOf('clickstack')
  // Both halves, or the guard proves nothing: that the attachment is named
  // from the artifact `clickstack`, and that this artifact is the string the
  // other repository composes. Asserting only the second re-tests `instanceFor`
  // and leaves the literal here free to be respelled.
  const [, artifact] =
    /const name = instanceFor\(\{ app: \$app\.name, stage: \$app\.stage, artifact: '([a-z-]+)' \}\)/.exec(source) ?? []
  assert.equal(artifact, 'clickstack', 'the attachment no longer takes its name from the published artifact')
  assert.equal(instanceFor({ app: 'boxlite-app', stage: 'dev', artifact }), 'boxlite-app-dev-clickstack')

  // ACCEPT_AUTOMATIC would let any project in the organization connect an
  // endpoint to this ClickHouse — a wider grant than the firewall below gives
  // anybody already inside the network.
  assert.match(source, /connectionPreference: 'ACCEPT_MANUAL'/)
  assert.match(source, /consumerAcceptLists: \[\{ projectIdOrNum: consumerProject/)
  // Proxy protocol prepends the consumer's endpoint address to the stream, and
  // ClickHouse would read those bytes as the first line of a request.
  assert.match(source, /enableProxyProtocol: false/)
})

test('the publication admits the two kinds of traffic that carry no service account', () => {
  /*
   * `clickhouse.ts`'s rule keys on service accounts, which is exact and covers
   * every caller inside this network. Neither packet here carries one: a health
   * probe originates in Google's own infrastructure, and a consumer's
   * connection has been translated into the NAT range on the way in. Without
   * both ranges the backend never turns healthy and the console reaches
   * nothing — with every resource created and the deploy green.
   */
  const source = sourceOf('clickstack')
  assert.match(source, /const HEALTH_PROBE_RANGES = \['35\.191\.0\.0\/16', '130\.211\.0\.0\/22'\]/)
  assert.match(source, /sourceRanges: \[\.\.\.HEALTH_PROBE_RANGES, PSC_NAT_CIDR\]/)
  /*
   * Passthrough rather than the `INTERNAL_MANAGED` scheme `api.ts` uses: a
   * managed balancer terminates the connection on an Envoy and speaks HTTP,
   * where the console's traffic is opaque TCP that has to arrive at ClickHouse
   * as it was sent.
   */
  assert.match(source, /loadBalancingScheme: 'INTERNAL'/)
  assert.equal(/loadBalancingScheme: 'INTERNAL_MANAGED'/.test(source), false)
  /*
   * And every backend of one names `CONNECTION`, because the provider's default
   * is the value that scheme refuses: a real apply answered
   * `Invalid value for field 'resource.backends[0].balancingMode': 'UTILIZATION'`
   * and created nothing. `edge.ts` states it for the same reason.
   */
  assert.match(source, /backends: \[\{ group: group\.id, balancingMode: 'CONNECTION' \}\]/)
})

test('the runner still reaches the control plane by a name this stack owns', () => {
  /*
   * `address` is what a runner is handed, and it becomes `BOXLITE_API_URL` in a
   * systemd unit written at first boot. `runner-update.ts` replaces the binary
   * and nothing else, so that value is frozen for the life of the host.
   *
   * This is the guard on the whole internal-balancer design. The shorter way to
   * keep a runner off the public path is to hand it Cloud Run's own `run.app`
   * address, and it works — until the service is renamed, at which point Google
   * derives a different hostname and every host already running is left calling
   * a name that answers nothing, with no mechanism to be told otherwise. The
   * internal balancer exists so the name can stay ours.
   */
  assert.match(sourceOf('api'), /address: \$util\.output\(`https:\/\/\$\{apiHost\}`\)/)
})

test('the private zone shadows the API hostname and nothing else', () => {
  /*
   * A zone is authoritative for everything at and below its name, and the
   * obvious spelling — one zone for `<domain>` — would make this network's
   * resolver authoritative for the dashboard and every box hostname too. Both
   * are served from balancers with no internal address at all, so the records
   * that answer for them today would simply stop being seen in here.
   */
  const source = sourceOf('api')
  assert.match(source, /visibility: 'private'/)
  assert.match(source, /dnsName: `\$\{apiHost\}\.`/)
  assert.equal(/dnsName: `\$\{domain\}\.`/.test(source), false, 'the zone covers the whole stack domain')
})

test('the internal balancer is internal, and carries a certificate a regional proxy can hold', () => {
  /*
   * Two values that fail apart from each other. A regional target proxy refuses
   * the global `ManagedSslCertificate` the public path uses — it takes a
   * Certificate Manager certificate created in the same region — and that
   * certificate has to prove the domain through DNS, because the reachability
   * check the public one passes cannot be run against a balancer nothing
   * outside the network can reach.
   */
  const source = sourceOf('api')
  assert.match(source, /new gcp\.compute\.RegionTargetHttpsProxy\(/)
  assert.match(source, /loadBalancingScheme: 'INTERNAL_MANAGED'/)
  assert.match(source, /certificateManagerCertificates: \[/)
  assert.match(source, /location: region,\n\s+managed: \{ domains: \[apiHost\], dnsAuthorizations:/)
})

test('the runner is fenced off one address, not off the internet, and only once the internal path serves', () => {
  /*
   * The fence is what turns "resolves internally" into "cannot do otherwise",
   * and it has two ways to be wrong that an apply reports as success.
   *
   * Too wide is a host that never boots: a runner downloads its own binary and
   * pulls every image over the same NAT, so an egress deny on the internet
   * strands it before it registers. Too early is the same outage from the other
   * side — a fence that lands before the internal balancer and its record are
   * serving closes the only route the fleet still has.
   */
  const source = sourceOf('api')
  assert.match(source, /direction: 'EGRESS'/)
  assert.match(source, /destinationRanges: \[address\.address\.apply\(/)
  assert.match(source, /targetServiceAccounts: \[runnerAccount\]/)
  assert.equal(/destinationRanges: \['0\.0\.0\.0\/0'\]/.test(source), false, 'the deny covers the internet')
  assert.match(source, /\{ dependsOn: \[internalForwarding, internalRecord\] \}/)
})
