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
import { publicHostsFor } from '../stack/api.ts'
import { alertPolicyFilter } from '../stack/providers/gcp/alarms.ts'
import { certificateNameFor, internalAuthorizationNameFor } from '../stack/providers/gcp/certificate-name.ts'
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
import { apiPrefixRouteRules } from '../stack/providers/gcp/api.ts'
import { isMissingNeg } from '../stack/providers/gcp/edge.ts'
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
 * Every project-level IAM resource this provider constructs, whichever
 * constructor it uses and however deeply it is nested.
 *
 * Scanning to a balanced close rather than matching a closing line. The first
 * version of this pinned `\n    })`, so it enumerated only blocks that closed
 * at exactly four spaces — a grant one level deeper, which is the shape
 * `RunnerArtifactsRead` already uses in this same file, went unseen and green.
 * `IAMBinding` is included because it is authoritative, and so the more
 * dangerous of the two to leave unbounded.
 *
 * It reads source text, which is the limit worth stating: it can see the
 * argument a constructor is written with, not the resource Pulumi synthesises
 * from it. A grant assembled from a variable would satisfy this and still be
 * unbounded.
 *
 * The scan skips comments and quoted literals, because a parenthesis inside
 * either is prose and not structure — counting them, as the first version did,
 * ends a block wherever someone writes one in a comment. What it still cannot
 * do is tell a regex literal from a division; nothing in these providers writes
 * one, and an unbalanced scan now throws rather than running to the end of the
 * file and returning a block that swallows the next grant's `condition:`.
 */
const endOfLiteral = (source: string, open: number): number => {
  const quote = source[open]
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === quote) return index
  }
  return -1
}

const projectIamBlocks = (source: string): string[] => {
  const blocks: string[] = []
  const opener = /new gcp\.projects\.IAM(?:Member|Binding)\(/g
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 0
    let index = match.index + match[0].length - 1
    let closed = false
    for (; index < source.length; index += 1) {
      const character = source[index]
      const pair = source.slice(index, index + 2)
      if (pair === '//') {
        const newline = source.indexOf('\n', index)
        if (newline === -1) break
        index = newline
        continue
      }
      if (pair === '/*') {
        const end = source.indexOf('*/', index + 2)
        if (end === -1) break
        index = end + 1
        continue
      }
      if (character === "'" || character === '"' || character === '`') {
        const end = endOfLiteral(source, index)
        if (end === -1) break
        index = end
        continue
      }
      if (character === '(') depth += 1
      else if (character === ')' && --depth === 0) {
        closed = true
        break
      }
    }
    assert.ok(closed, `the IAM grant at offset ${match.index} never closes, so this scan proves nothing`)
    blocks.push(source.slice(match.index, index + 1))
  }
  return blocks
}

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
    volumePrefix: 'boxlite-volume',
  })

// ── the container's port ────────────────────────────────────────────────────

const DECLARATION = { groups: { deploy: [], api: [] }, where: '/repo/mstage.config.json' }

const apiEnvironment = (home: 'aws' | 'gcp', overrides: Record<string, string> = {}) =>
  apiEnvironmentFrom({
    environment: {
      STACK_DOMAIN: 'dev2.boxlite.ai',
      OIDC_ISSUER_BASE_URL: 'https://auth.dev2.boxlite.ai',
      ...overrides,
    },
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

// ── which object store backs a volume ───────────────────────────────────────

test('a GCP stage tells the API to create volume buckets on GCS, in its own region', () => {
  /*
   * The runner defaults to s3, and the API defaults with it, so a GCP stage
   * that names nothing creates S3 buckets that no host on it can mount. The
   * failure is not at deploy time: the stage comes up, and the first volume a
   * user creates is the one that fails.
   *
   * The location is the stage's region rather than a constant. A bucket
   * created without one lands wherever the client defaults to, which is a
   * cross-region read on every file a box touches, billed per operation.
   */
  const gcp = apiEnvironment('gcp')
  assert.equal(gcp.VOLUME_STORAGE_BACKEND, 'gcs')
  assert.equal(gcp.GCS_LOCATION, 'asia-southeast1')
})

test('the runner unit names the project a bare secret id is resolved against', () => {
  /*
   * The start wrapper fetches every secret with
   * `gcloud secrets versions access --secret=<id>`, and an id names no project.
   * gcloud on GCE falls back to the metadata server's, which is the platform's
   * answer rather than this stack's: a host whose instance metadata says one
   * project and whose stage declares another reads the wrong secret, or none.
   * Its sibling `VOLUME_STORAGE_BACKEND` is asserted two tests down, and this
   * one travels in the same block for the same reason.
   */
  const source = sourceOf('runners')
  assert.match(source, /gcloud secrets versions access "\$version" --secret="\$secret"/, 'the wrapper no longer fetches by id')
  assert.match(source, /CLOUDSDK_CORE_PROJECT: project/, 'so the unit must name the project it resolves against')
})

test('an AWS stage names neither, so it keeps mount-s3 and its bucket lifecycle', () => {
  // The compatibility half: the backend switch defaults to s3 on both sides,
  // and an AWS stage reaches that default by saying nothing at all.
  const aws = apiEnvironment('aws')
  assert.equal('VOLUME_STORAGE_BACKEND' in aws, false)
  assert.equal('GCS_LOCATION' in aws, false)
})

test('the runner is told to mount with the tool its host was actually given', () => {
  /*
   * Two lines of one file that have to agree: `installVolumeMount` puts
   * gcsfuse on the host, and `unitEnvironment` decides which tool the runner
   * reaches for. Install gcsfuse and say nothing, and the runner keeps its s3
   * default and execs mount-s3 — a binary this platform never installs — so
   * every box that asks for a volume fails on a missing executable.
   */
  const source = sourceOf('runners')
  assert.match(source, /apt-get install -y gcsfuse/, 'the host is not given gcsfuse')
  assert.match(source, /const VOLUME_BACKEND = 'gcs'/, 'the backend this cloud mounts with is not named')
  assert.match(source, /VOLUME_STORAGE_BACKEND: VOLUME_BACKEND/, 'the runner is not told to use it')
  /*
   * And the same constant reaches the policy that converges a host created
   * before the key existed. Two spellings is a fleet that never converges —
   * the defect `runnerApiUrl` was extracted to prevent, one key over.
   */
  assert.match(source, /volumeBackend: VOLUME_BACKEND/, 'the policy is told a second, separate answer')
  // The AWS provider installs it from mountpoint-s3-release; matching the
  // install rather than the name keeps this from passing on prose that merely
  // mentions mount-s3, which the comment above the variable does.
  assert.equal(source.includes('mountpoint-s3-release'), false, 'this platform installs a mount-s3 to fall back to')
})

test('the host that mounts holds a grant on the buckets it mounts', () => {
  /*
   * gcsfuse mounts as the instance's service account — it is handed no
   * credential, exactly as mount-s3 on AWS falls through to the instance role.
   * So the runner's own identity needs the volume grant, and the AWS provider
   * gives its role one (`RunnerVolumeS3Policy`). Without the counterpart here
   * the deploy succeeds, the host boots, gcsfuse is installed, the backend is
   * selected — and the first mount is answered 403 by Cloud Storage.
   *
   * The bucket-level half is the one that is easy to drop: `storage.buckets.get`
   * is what gcsfuse calls once per mount for GetStorageLayout, no object role
   * includes it, and object access alone fails before reading a byte.
   */
  const grants = projectIamBlocks(sourceOf('runners'))
  /*
   * Read out of each grant's own block rather than out of the file. An earlier
   * revision matched the role and the condition across the whole source with a
   * lazy `[\s\S]*?` between them, which walks out of the block it started in:
   * delete this grant's condition and the gap simply runs on to the next
   * grant's, leaving the assertion green with the property it names gone.
   *
   * Roles are pinned per resource and not as loose strings, for the same reason.
   * `objectViewer` sits beside `objectUser` on another app's runtime account in
   * this same project, so it is the natural thing to copy here — but its
   * permissions are a subset of `objectUser`'s and neither carries
   * `storage.buckets.get`, so the pair that reads as safer mounts nothing. This
   * file also grants `objectViewer` for the staged binary, which is right and
   * unrelated, so a check on a role alone would pass for the wrong grant.
   */
  const grantNamed = (name: string): string => {
    const found = grants.filter((block) => block.includes(`('${name}',`))
    assert.equal(found.length, 1, `expected one ${name} grant, found ${found.length}`)
    return found[0]
  }

  const objects = grantNamed('RunnerVolumeObjects')
  assert.match(objects, /role: 'roles\/storage\.objectUser'/, 'the host cannot read or write volume objects')
  assert.match(
    objects,
    /condition: volumeConditionFor\(volumePrefix\)/,
    'the volume object grant reaches every bucket in the project',
  )

  const buckets = grantNamed('RunnerVolumeBuckets')
  /*
   * `bucketViewer` rather than the `legacyBucketReader` this once named. The
   * legacy role is the tighter of the two — beside `objectUser` it adds exactly
   * `storage.buckets.get` — and it is still right where `storage.ts` uses it,
   * bound on one bucket. At a *project* it is refused outright: `Role
   * roles/storage.legacyBucketReader is not supported for this resource`, a 400
   * that fails the whole apply rather than this one binding. A volume bucket is
   * created per volume, so a project grant is the only shape available here.
   */
  assert.match(
    buckets,
    /role: 'roles\/storage\.bucketViewer'/,
    'the host cannot call GetStorageLayout, so every mount fails',
  )
  assert.doesNotMatch(
    buckets,
    /legacyBucketReader/,
    'a legacy role cannot be granted at a project; this binding would 400 the apply',
  )
  assert.match(
    buckets,
    /condition: volumeConditionFor\(volumePrefix\)/,
    'the bucket grant reaches every bucket in the project',
  )
})

test('the volume grant cannot reach the bucket the staged binary lives in', () => {
  /*
   * The regression this file could not see until it was written down. Fifteen
   * lines above the volume grant, `RunnerArtifactsRead` confines these same
   * hosts to reading one prefix of the artifacts bucket — read-only, because a
   * runner that could write there could replace the binary every other host
   * installs. The AWS side says so outright: "a runner can never write here."
   *
   * Google has no wildcard between "one named resource" and "the whole
   * project", so the volume grant is a project-level role narrowed by a CEL
   * condition. Drop the condition and the role is simply project-wide:
   * `objectUser` carries `storage.objects.create` and `.delete`, so it
   * subsumes the artifacts binding and the confinement above becomes a comment.
   * That is not a hypothetical — it is what an earlier revision of this change
   * did, and nothing here caught it.
   *
   * Asserting on the condition alone would not catch it either, since a grant
   * can carry a condition about something else. The pairing is what matters:
   * every project-level role handed to the runner's own account is bounded by
   * the volume prefix.
   */
  const grants = projectIamBlocks(sourceOf('runners'))
  assert.ok(grants.length >= 2, `expected the two volume grants, found ${grants.length}`)
  for (const grant of grants) {
    assert.match(
      grant,
      /condition: volumeConditionFor\(volumePrefix\)/,
      `a project-level grant here reaches every bucket in the project:\n${grant}`,
    )
  }
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
  // One composition for both names, asked of the same function the environment
  // above asks. Two derivations is a balancer serving one name and a dashboard
  // told another, with nothing failing at deploy time to say so.
  assert.match(source, /const hosts = publicHostsFor\(\{ domain, dashboardDomain \}\)/)
  assert.match(source, /const apiHost = hosts\.api/)
  // Serving the name is two things, and one without the other is still broken:
  // a certificate that does not cover it fails the handshake, and a record that
  // does not exist holds that certificate in FAILED_NOT_VISIBLE.
  assert.match(source, /certificateFor\('ApiCertificate', 'api', apiHost\)/)
  assert.match(source, /name: apiHost/)
  // And `address` is what the proxy and the runner call, so it is the API's
  // hostname rather than the dashboard's.
  assert.match(source, /address: \$util\.output\(`https:\/\/\$\{apiHost\}`\)/)
})

test('a stage may serve its dashboard elsewhere, and the control plane does not follow', () => {
  /*
   * prod publishes the dashboard at `app.boxlite.ai` and leaves the apex to the
   * marketing site, so its stage domain is `boxlite.ai` and its control plane
   * `api.boxlite.ai`. What moves with the dashboard is the certificate, the
   * public record and `DASHBOARD_URL`; what must not is `api.<domain>` — a
   * runner is handed that at first boot, in a unit `runner-update.ts` does not
   * rewrite, and the private zone answers for that name alone.
   */
  assert.deepEqual(publicHostsFor({ domain: 'boxlite.ai', dashboardDomain: 'app.boxlite.ai' }), {
    dashboard: 'app.boxlite.ai',
    api: 'api.boxlite.ai',
  })

  const moved = apiEnvironment('gcp', { DASHBOARD_DOMAIN: 'app.dev2.boxlite.ai' })
  assert.equal(moved.DASHBOARD_URL, 'https://app.dev2.boxlite.ai')
  assert.equal(moved.DASHBOARD_BASE_API_URL, 'https://api.dev2.boxlite.ai')
  // The browser is redirected here at the end of a logout, so it is the origin
  // it is already on rather than the control plane's.
  assert.equal(moved.OIDC_END_SESSION_ENDPOINT, 'https://app.dev2.boxlite.ai/api/auth/end-session')

  // And the balancer publishes the same name: the record it points at this
  // address, and the origin the dashboard is served from.
  const source = sourceOf('api')
  assert.match(source, /name: hosts\.dashboard/)
  assert.match(source, /url: \$util\.output\(`https:\/\/\$\{hosts\.dashboard\}`\)/)
})

/**
 * One request through the rules, by the rule the load balancer documents: the
 * first matching rule by priority wins, and `pathPrefixRewrite` replaces
 * exactly the portion of the path that matched.
 */
const throughBalancer = (path: string): string => {
  const rules = [...apiPrefixRouteRules('backend-1')].sort((a, b) => a.priority - b.priority)
  for (const rule of rules) {
    const matched = rule.matchRules
      .map((match: { fullPathMatch?: string; prefixMatch?: string }) =>
        match.fullPathMatch === path
          ? match.fullPathMatch
          : match.prefixMatch !== undefined && path.startsWith(match.prefixMatch)
            ? match.prefixMatch
            : null,
      )
      .find((portion: string | null | undefined) => typeof portion === 'string')
    if (matched === undefined) continue
    const rewrite = (rule as { routeAction?: { urlRewrite: { pathPrefixRewrite: string } } }).routeAction
    return rewrite ? `${rewrite.urlRewrite.pathPrefixRewrite}${path.slice((matched as string).length)}` : path
  }
  throw new Error(`no rule matches ${path}`)
}

test('the control plane’s own host is called without the prefix the container mounts under', () => {
  /*
   * `apps/api` sets `/api` globally, which is what lets one image serve the
   * dashboard at `/` and the control plane beside it. On a hostname that is
   * only the control plane's, that prefix is repeated for nothing — so the
   * balancer puts it back and the address a client holds is just the host.
   *
   * The rewrite value has to end in a slash, because the portion it replaces
   * is the matched `/`. `'/api'` instead would send `/boxes` to the container
   * as `/apiboxes`, which answers 404 with nothing in the deploy having failed.
   */
  assert.equal(throughBalancer('/boxes'), '/api/boxes')
  assert.equal(throughBalancer('/'), '/api/')

  /*
   * And the long form still reaches the same route. It is what every runner
   * booted with, what `edge.ts` hands the proxy and what every SDK profile in
   * the field holds; rewriting it would ask for `/api/api/boxes`.
   */
  assert.equal(throughBalancer('/api/boxes'), '/api/boxes')
  assert.equal(throughBalancer('/api'), '/api')

  // Both forms reach the backend this balancer fronts, and only it.
  assert.deepEqual(new Set(apiPrefixRouteRules('backend-1').map((rule) => rule.service)), new Set(['backend-1']))
})

test('no certificate carries two names a stage can move independently', () => {
  /*
   * A managed certificate is issued only once *every* domain on it validates,
   * and the balancer presents nothing until then — so one certificate covering
   * two names lets the slower one decide when the faster is served.
   *
   * Moving prod's dashboard onto `app.boxlite.ai` is what proved it. The two
   * names shared a certificate; `api.boxlite.ai` validated within minutes and
   * then sat dark behind a hostname that had never existed before, with the
   * public control plane unreachable and nothing wrong with it. Splitting them
   * is what keeps one name's first provisioning off the other's availability.
   */
  const source = sourceOf('api')
  const covered = [...source.matchAll(/managed: \{ domains: (\[[^\]]*\])/g)].map((match) => match[1])
  assert.ok(covered.length > 0, 'this provider declares no managed certificate at all')
  for (const domains of covered) {
    assert.equal(
      domains.split(',').length,
      1,
      `a certificate covers ${domains}; whichever of those is slowest to validate holds the rest dark`,
    )
  }

  // Both of them on the one proxy, or a name resolves here with nothing to
  // present. The control plane leads, because the head of that list is what a
  // client sending no SNI is given — an SDK or a CLI rather than a browser.
  assert.match(source, /sslCertificates: \[certificate\.id, dashboardCertificate\.id\]/)
})

test('the regional certificate is named after the authorization it is issued against', () => {
  /*
   * `managed` is immutable, so replacing the DNS authorization replaces this
   * certificate. Keyed on the host instead, its name would not move when the
   * authorization's did — and Certificate Manager refuses a second resource
   * under an occupied name, so the create-first replacement fails and the stage
   * cannot deploy at all. That is not hypothetical: it is what a stage still
   * carrying the pre-rename authorization name walks into.
   */
  const base = instanceFor({ app: 'boxlite-app', stage: 'dev', artifact: 'api-internal' })
  const host = 'api.dev.boxlite.ai'
  assert.notEqual(
    certificateNameFor({ key: internalAuthorizationNameFor({ app: 'boxlite-app', stage: 'dev', host }), base }),
    certificateNameFor({ key: host, base }),
    'keying the certificate on its authorization must not collapse back to the host',
  )

  // And the provider keys it that way rather than on the host.
  const source = sourceOf('api')
  assert.match(source, /const internalAuthorizationName = internalAuthorizationNameFor\(/)
  assert.match(source, /name: internalAuthorizationName,/, 'the authorization must use the name the certificate keys on')
  assert.match(source, /key: internalAuthorizationName,/, 'the certificate must be keyed on the authorization')
})

test('a certificate is named after the domain it covers, so a move is a create first', () => {
  /*
   * Its domains are immutable, so changing the domain replaces the certificate
   * — and the target proxy still references the original at that moment, which
   * GCP refuses to delete with `RESOURCE_STILL_IN_USE`. A name that did not
   * move with the domain would leave the replacement refused under an occupied
   * name, and the stage with a certificate it can neither keep nor replace.
   */
  const base = instanceFor({ app: 'boxlite-app', stage: 'prod', artifact: 'api' })
  assert.notEqual(
    certificateNameFor({ key: 'api.app.boxlite.ai', base }),
    certificateNameFor({ key: 'api.boxlite.ai', base }),
  )
  // And the dashboard's is a different resource, so the two cannot collide even
  // when a stage serves both from one domain.
  assert.notEqual(
    certificateNameFor({ key: 'boxlite.ai', base }),
    certificateNameFor({ key: 'boxlite.ai', base: `${base}-dashboard` }),
  )
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
  // Every script, not a count of them: the assignment carries more than one
  // policy now, and a rule keyed to how many would be rewritten rather than
  // read the next time one is added.
  const interpreters = source.match(/interpreter: '[A-Z]+'/g) ?? []
  assert.ok(interpreters.length > 0, 'the assignment declares no exec script at all')
  assert.deepEqual(
    [...new Set(interpreters)],
    ["interpreter: 'NONE'"],
    'every policy script has to be run directly, whichever policy it belongs to',
  )
})

test('a host that cannot be told the new control-plane name is converged to it', () => {
  /*
   * `BOXLITE_API_URL` is written once, at first boot. `metadataStartupScript`
   * is in `ignoreChanges` and the instance is protected, so a stage that
   * changes its domain strands every host it already has: the public record is
   * renamed, the private zone is rebuilt under the new name, and the old one
   * resolves nowhere. Without this policy the fleet is recovered by hand or
   * recreated, and recreating one loses `/var/lib/boxlite`.
   */
  const source = sourceOf('runners')
  assert.match(source, /id: 'runner-unit-env'/, 'nothing converges the unit environment')
  assert.match(source, /renderUnitEnvironmentPolicyScripts/)

  /*
   * In the binary's assignment rather than its own. Both policies end in
   * `systemctl restart`, and two assignments carry two `disruptionBudget`s —
   * which is how one host gets restarted by each of them at the same time.
   */
  assert.equal(source.match(/new gcp\.osconfig\.OsPolicyAssignment\(/g)?.length, 1)
  assert.match(source, /disruptionBudget: \{ fixed: 1 \}/)
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

test('the cluster enables Workload Identity and installs no driver nothing mounts', () => {
  /*
   * The Secret Manager add-on was here for one reader: the proxy's CSI volume.
   * That volume is gone — the stack writes the Kubernetes Secret directly — and
   * the proxy is the only workload on this cluster, so the add-on would install
   * a driver and a provider for nobody. Workload Identity stays: it is how the
   * Pod's service account is the proxy's Google one.
   */
  const source = sourceOf('cluster')
  assert.match(source, /workloadIdentityConfig: \{ workloadPool: `\$\{project\}\.svc\.id\.goog` \}/)
  // Named, not deleted: a removed property left the provider with nothing to
  // send, and GKE answered `Error 400: Must specify a field to update` on the
  // apply that followed the add-on's removal.
  assert.match(source, /secretManagerConfig: \{ enabled: false \}/, 'no CSI driver without a mount to serve')
  // The metadata server is Autopilot's own default; what still has to be said
  // is which identity its nodes run as, or they fall back to the project's
  // default Compute account.
  assert.match(source, /autoProvisioningDefaults: \{\s*serviceAccount: nodeAccount\.email/)
  assert.match(source, /enablePrivateNodes: true/)
})

test('the proxy key reaches the container as a Secret this stack writes', () => {
  /*
   * The app reads one channel — `PROXY_API_KEY` — so the value has to arrive as
   * a value, and never as a *literal* in the Deployment manifest, which
   * anything able to describe the workload can read.
   *
   * It used to arrive through the CSI driver's `secretObjects`, and on GKE's
   * managed provider that never happened: the driver mounts the file and
   * ignores the sync. Every Pod reported `mounted: true` while the object it
   * named did not exist, so a rollout stalled in `CreateContainerConfigError:
   * secret "proxy-api-key" not found` and only the old ReplicaSet — which
   * still read the file — kept serving.
   *
   * What this replaces asserted the opposite: that no `kubernetes.core.v1
   * .Secret` is declared here, so the payload stayed out of Pulumi state. That
   * property is genuinely lost, and it is what a Secret that exists costs.
   */
  const source = sourceOf('edge')
  assert.match(source, /kubernetes\.core\.v1\.Secret/, 'the stack has to write the object itself')
  assert.match(source, /stringData: \{ \[PROXY_API_KEY\]: \$util\.secret\(apiKeyPayload\) \}/)
  assert.match(source, /delete plainEnvironment\[PROXY_API_KEY\]/, 'the key must not reach the plain environment')
  assert.match(source, /valueFrom: \{ secretKeyRef: \{ name: PROXY_API_KEY_SECRET, key: PROXY_API_KEY \} \}/)
  assert.equal(
    /secretObjects: \[/.test(source),
    false,
    'the sync this provider ignores must not come back',
  )
  assert.equal(
    /SecretProviderClass|secrets-store-gke\.csi\.k8s\.io/.test(source),
    false,
    'the CSI mount fed the file channel the proxy no longer has',
  )
})

test('the Kubernetes identity maps to the existing proxy GSA and reaches no secret of its own', () => {
  /*
   * The pod-side grant went with the mount. It existed so the CSI driver could
   * fetch the key with the pod's identity; the stack writes the Kubernetes
   * Secret itself now, so a Pod that could still read Secret Manager would be
   * carrying an access nothing in it uses.
   */
  const source = sourceOf('edge')
  assert.match(source, /'iam\.gke\.io\/gcp-service-account': placement\.serviceAccount/)
  assert.match(source, /role: 'roles\/iam\.workloadIdentityUser'/)
  assert.equal(
    /roles\/secretmanager\.secretAccessor/.test(source),
    false,
    'the proxy reads its key from etcd, not from Secret Manager',
  )
})

test('a zone GKE has not created a NEG in yet is skipped, and nothing else is', () => {
  /*
   * GKE creates one NEG per node zone on its own schedule, and Autopilot adds
   * node zones whenever the region has room: `us-east5-c` got its NEG 28
   * seconds after the Deployment went ready, while the lookup was running. That
   * used to abort the update — after the backend and forwarding rule had
   * already been deleted for replacement, so the box proxy sat with no public
   * address until the next apply.
   *
   * Absence is therefore survivable. Anything else is not: a quota or
   * permissions failure read as absence would drop a zone that does have
   * endpoints, leaving a short backend with every resource green.
   */
  const name = 'boxlite-app-dev-proxy'
  assert.equal(isMissingNeg(new Error(`The resource 'projects/p/zones/us-east5-c/networkEndpointGroups/${name}' was not found`), name), true)
  assert.equal(isMissingNeg(new Error(`googleapi: Error 404: not found: ${name}, notFound`), name), true)
  /*
   * The bare two-word form, which is what the *invoke* path answers with and
   * what a real prod apply hit: `.../zones/us-east5-c/networkEndpointGroups/
   * <name> not found`. The first predicate only knew the REST wordings, so the
   * skip never fired and the update aborted on exactly the zone it was written
   * to survive.
   */
  assert.equal(
    isMissingNeg(new Error(`projects/p/zones/us-east5-c/networkEndpointGroups/${name} not found`), name),
    true,
  )
  // Another resource's absence says nothing about this one.
  assert.equal(isMissingNeg(new Error("The resource 'projects/p/zones/us-east5-c/instances/other' was not found"), name), false)
  // And a failure that is not an absence stays fatal.
  assert.equal(isMissingNeg(new Error(`Error 403: Required 'compute.networkEndpointGroups.get' on ${name}`), name), false)
  assert.equal(isMissingNeg(new Error(`Error 429: Quota exceeded for ${name}`), name), false)

  const source = sourceOf('edge')
  // The skip is what keeps a partial answer usable; an empty one is still fatal.
  assert.match(source, /if \(found\.length === 0\)/)
  /*
   * And the alarm reads off that same lookup. It used to run a second,
   * `Output`-shaped one of its own, which stayed fatal on exactly the zone the
   * first one was rewritten to survive — so the update still aborted at the
   * same point, for the same reason, with the entry point already deleted.
   */
  assert.equal(source.match(/getNetworkEndpointGroup\(\{/g)?.length, 1)
  assert.equal(/getNetworkEndpointGroupOutput\(/.test(source), false)
})

test('a Pod may reach the resolver it is actually pointed at, not only kube-dns', () => {
  /*
   * Autopilot enables NodeLocal DNSCache, whose DaemonSet runs on the host
   * network and binds a link-local address that a Pod's `/etc/resolv.conf`
   * then names. Host-network traffic carries no Pod identity, so an egress
   * rule written only as `namespaceSelector: kube-system` never matches it and
   * Dataplane V2 drops every query.
   *
   * The failure is silent in the worst way: the first GKE proxy reported
   * `lookup api.dev.boxlite.ai: i/o timeout`, retried ten times and exited 2,
   * which reads as the control plane being down rather than as a policy.
   */
  const source = sourceOf('edge')
  assert.match(source, /const NODE_LOCAL_DNS = '169\.254\.20\.10\/32'/)
  assert.match(source, /\{ ipBlock: \{ cidr: NODE_LOCAL_DNS \} \}/)
  // Both, not either: the selector is still what reaches kube-dns on a cluster
  // running without the node-local cache in front of it.
  assert.match(source, /namespaceSelector: \{ matchLabels: \{ 'kubernetes\.io\/metadata\.name': 'kube-system' \} \}/)
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
  /*
   * The lookup is still ordered behind the readiness gate, by resolving
   * `deployment.id` alongside the zone list rather than by a `dependsOn` on an
   * `Output`-shaped lookup: it has to await a per-zone absence it means to
   * survive, and `getNetworkEndpointGroupOutput` gives it nothing to catch.
   */
  assert.match(source, /\$resolve\(\[host\.zones, deployment\.id\]\)/)
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
