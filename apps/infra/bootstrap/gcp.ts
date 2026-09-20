// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * `npm run bootstrap -- --stage <stage>` when `mstage.config.json` says this
 * stage's home is `gcp`.
 *
 * Every item here exists for the same reason its AWS counterpart in
 * `bootstrap.ts` does: the deploy cannot create it, because the deploy needs
 * it in order to run.
 *
 *   the enabled APIs         nothing can be created through an API that is off
 *   the state bucket         Pulumi keeps its state there and mstage its store,
 *                            so it exists before either has anywhere to write
 *   mstage-bootstrap         the record that names that bucket; the GCS
 *                            counterpart of AWS's `/sst/bootstrap`
 *   mstage-passphrase-*      what the store is sealed with. Generated once and
 *                            never rotated here: rotating it would make every
 *                            stored value unreadable
 *   the identity pool        CI proves a GitHub OIDC token and nothing else, so
 *                            the pool that trusts it cannot come from a deploy
 *                            that has not been authorised yet
 *   the deployer             the identity mdeploy runs as
 *   the image publisher      assumed by mbuild.yml, which runs before any
 *                            stage is deployed at all
 *   the docker repository    a first publish would fail on push into a
 *                            repository nothing created
 *
 * Reconciles rather than creates, exactly like the AWS side: re-running is how
 * an edit to the role list below reaches GCP.
 *
 * Talks to `gcloud` rather than adding the Google SDKs to this directory's
 * dependency surface — the same choice `bootstrap.ts` makes about `aws`, and
 * for the same reason: the CLI is a prerequisite for operating the project at
 * all, and this runs on a workstation.
 *
 * The state bucket's name is never printed. It is protected by IAM either way,
 * but it is also the one name that says where every stage's secrets live, and
 * this repository keeps it out of terminal output and CI logs on both clouds.
 *
 * Modelled on boxlite-backoffice's `apps/infra/iam/src/gcp.ts` (as of
 * 227d9f5), the prior art `mstage`'s own GCP fixes were ported from in
 * 50665ad0. The role and service lists below are BoxLite's own, though,
 * derived from what `mdeploy/stack/providers/gcp/*.ts` actually instantiates
 * rather than copied — this stack has a cache and no pub/sub, backoffice's has
 * the reverse.
 */

import { randomBytes } from 'node:crypto'
import { gcpRunnerArtifactsBucket } from '../mdeploy/stack/runner-binary.ts'
import { identityFor, poolFor } from 'naming'

export class GcpBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GcpBootstrapError'
  }
}

/** One external command. A non-zero exit is reported, never thrown away. */
export type RunResult = { code: number; stdout: string; stderr: string }

/**
 * `stdin` is how a secret reaches a command without passing through argv,
 * which is readable in the process table for as long as the command runs.
 * Here it carries the passphrase the store is sealed with and the JSON record
 * naming the state bucket.
 */
export type RunOptions = { stdin?: string }
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>

/** Where every workload identity pool in this file lives. Pools are not regional. */
const POOL_LOCATION = 'global'

/** One pool per project, holding the one provider that trusts GitHub. `naming` names the pool. */
const POOL_PROVIDER = 'github'

/** The record mstage reads to find the store, and the key inside it. */
const BOOTSTRAP_SECRET = 'mstage-bootstrap'

/**
 * Every API a resource in `mdeploy/stack/providers/gcp/` needs.
 *
 * Derived from that bundle rather than from a checklist: `grep -hoE "new
 * gcp\.[A-Za-z0-9]+\.[A-Za-z0-9]+" mdeploy/stack/providers/gcp/*.ts` names
 * every resource type the stack builds, and each line below names what asked
 * for it. An API left off does not fail at plan time: the apply reaches that
 * resource and returns `SERVICE_DISABLED`, halfway through.
 */
const SERVICES = [
  // Network, Subnetwork, Router, RouterNat, Firewall, Address, GlobalAddress,
  // BackendService, RegionBackendService, the two ForwardingRules,
  // TargetHttpsProxy, URLMap, ManagedSslCertificate, the runner/ClickHouse
  // instances and their disks.
  'compute.googleapis.com',
  // The GKE control plane and node pool that run the proxy.
  'container.googleapis.com',
  // cloudrunv2.Service for the api and the otel-collector.
  'run.googleapis.com',
  // redis.Instance: the cache.
  'redis.googleapis.com',
  // sql.DatabaseInstance, sql.Database, sql.User.
  'sqladmin.googleapis.com',
  // servicenetworking.Connection: the private services access the database
  // instance is reachable through.
  'servicenetworking.googleapis.com',
  // secretmanager.Secret and SecretVersion — the stack's own, and the two this
  // file creates.
  'secretmanager.googleapis.com',
  // The state bucket, for both Pulumi's state and mstage's store, and the
  // stack's own storage.Bucket.
  'storage.googleapis.com',
  // The repository a stage's images are published into.
  'artifactregistry.googleapis.com',
  // Where mbuild's scan gate reads an image's findings from
  // (`mbuild/src/publish.ts`, `scanReport`). Artifact Analysis, which is what
  // would write those findings, is deliberately not enabled here: it bills per
  // image scanned. So the gate reads an empty answer and blocks on nothing
  // until `containerscanning.googleapis.com` joins this list — green, not
  // absent, which is the thing to know about it.
  'containeranalysis.googleapis.com',
  // The OS policy that lands a new runner binary on a host that already exists.
  // A deploy declares the desired state and each host's own agent converges to
  // it, which is what replaces the tunnelled ssh that needed OS Login.
  'osconfig.googleapis.com',
  // certificatemanager.DnsAuthorization, Certificate, CertificateMap and
  // CertificateMapEntry: the box proxy's wildcard certificate, which only
  // Certificate Manager can issue as a Google-managed one.
  'certificatemanager.googleapis.com',
  // serviceaccount.Account and the workload identity pool this file creates.
  'iam.googleapis.com',
  // Minting tokens for a federated identity, which is how CI signs in at all.
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  // logging.Metric, and monitoring.AlertPolicy built on top of them.
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  // projects.IAMMember: the stack grants project-level roles to its own
  // service accounts.
  'cloudresourcemanager.googleapis.com',
]

/**
 * What the deploy identity may do, one role per group of resources that needs it.
 *
 * Wide on purpose, for now. The AWS side reaches the same place with a single
 * bespoke inline policy fenced by a permissions boundary (`bootstrap/aws/deploy-role-policy.json`);
 * GCP has no such umbrella, so this is the list of admin roles the bundle's
 * resource types actually require. Narrowing this is the step to take once a
 * first apply has succeeded and the audit log says which permissions were
 * used — guessing a smaller set beforehand produces a deploy that fails in ten
 * places in turn.
 *
 * SELF-ESCALATION, stated rather than buried. `resourcemanager.projectIamAdmin`
 * together with `iam.serviceAccountAdmin` and `iam.serviceAccountUser` lets
 * this identity grant itself any role in the project, including owner. The AWS
 * half denies exactly that path — the inline policy allows `iam:CreateRole`
 * only when the request attaches the account's permissions boundary, and
 * denies every user and group write — and GCP has no boundary to attach, so
 * nothing here reproduces the fence.
 *
 * It is not gratuitous: the stack grants project-level roles itself
 * (`gcp.projects.IAMMember` in `stack/providers/gcp/api.ts`, `database.ts`,
 * `cache.ts` and `clickhouse.ts`), and the members are service accounts the
 * stack creates, so bootstrap cannot pre-create those bindings and hand the
 * deployer something narrower.
 *
 * What stands in for the fence today is who may assume this identity at all:
 * only a job in this repository, pinned by immutable owner and repository id
 * (`attributeCondition` below), declaring this stage's environment. The real
 * fix is an organization policy restricting which roles may be granted in the
 * project, which is org-level and outside this repository.
 */
const DEPLOYER_ROLES = [
  // Every compute.* resource: the network, the NAT, the firewall rules, the
  // load balancer in front of the proxy, and the runners.
  'roles/compute.admin',
  // The proxy's GKE cluster and node pool, plus Kubernetes API access as the
  // cluster creator for the Deployment, the Service and the Secret the proxy's
  // key arrives in.
  'roles/container.admin',
  // The api and the otel-collector.
  'roles/run.admin',
  // The cache.
  'roles/redis.admin',
  // The database instance, its database and its user.
  'roles/cloudsql.admin',
  // The private services access connection the database sits behind.
  'roles/servicenetworking.networksAdmin',
  // The stack's own secrets, and reading the two this file created.
  'roles/secretmanager.admin',
  // Pulumi's state and mstage's store, both in the bucket below, and the
  // stack's own buckets.
  'roles/storage.admin',
  // Creating the service accounts each workload runs as...
  'roles/iam.serviceAccountAdmin',
  // ...and being allowed to run a revision or an instance as one of them,
  // which is a separate permission from having created it.
  'roles/iam.serviceAccountUser',
  // gcp.projects.IAMMember: the stack grants project-level roles to those
  // service accounts.
  'roles/resourcemanager.projectIamAdmin',
  // The OS policy assignment that upgrades the runner fleet in place.
  'roles/osconfig.osPolicyAssignmentAdmin',
  // The log-based metrics the alert policies are built on, and the policies.
  'roles/logging.configWriter',
  'roles/monitoring.editor',
  // The proxy's certificate: a DNS authorization, a managed certificate, and
  // the map the load balancer resolves a hostname through. `compute.admin`
  // does not reach any of them — Certificate Manager is its own service, and
  // the apply dies at `ProxyDnsAuthorization` without this.
  'roles/certificatemanager.owner',
  // The private zone that answers for `api.<domain>` inside the network, and
  // the record in it. Cloud DNS is its own service too — `compute.admin` does
  // not reach a managed zone, and the apply dies at `ApiInternalZone` with a
  // bare `403: Forbidden` that names neither the permission nor the role.
  'roles/dns.admin',
  /*
   * Reading back what mbuild published, before an apply that cannot pull.
   *
   * The preflight gate runs `mbuild verify` as this identity rather than as
   * the publisher (`mdeploy.yml`'s "Verify the images"), and the read under it
   * — `gcloud artifacts docker images list` — needs
   * `artifactregistry.repositories.get`. Nothing else in this list reaches
   * Artifact Registry, so the gate is refused and `publish.ts`'s `unreadable`
   * reports a question it could not answer, failing a deploy of images the
   * repository is holding.
   *
   * Read and not write: the publisher pushes (`PUBLISHER_ROLES` below), and
   * this identity only asks whether the push landed.
   */
  'roles/artifactregistry.reader',
  /*
   * Reaching a live runner to replace its binary in place.
   *
   * Two roles for one job, because the tunnel and the login are separate
   * permissions. `iap.tunnelResourceAccessor` opens IAP's TCP forward to port
   * 22 — the rule that admits it is `RunnerIapFirewall` in
   * `mdeploy/stack/providers/gcp/network.ts` — and `compute.osAdminLogin` is
   * what lets gcloud mint a key for this identity and use sudo once it is in.
   *
   * A deploy-time channel, not an operator's back door: a runner's boot script
   * is ignored after first boot and the instance is never replaced, so a new
   * binary has no other way onto a host that already exists.
   * `mdeploy/stack/runner-upgrade.ts` records the rest of the reasoning.
   */
  'roles/iap.tunnelResourceAccessor',
  'roles/compute.osAdminLogin',
]

/**
 * The publisher pushes images, and reads back what was found in them.
 *
 * Two services, so two roles: `artifactregistry.writer` carries the push, and
 * the scan gate's read reaches Container Analysis instead — `gcloud artifacts
 * docker images describe --show-package-vulnerability` lists occurrences, and
 * nothing in the registry's own role grants `containeranalysis.occurrences
 * .list`. Without the second the publish pushes the image and then cannot read
 * its findings, which mbuild reports as a publish failure and retries three
 * times over an answer that never changes.
 */
const PUBLISHER_ROLES = ['roles/artifactregistry.writer', 'roles/containeranalysis.occurrences.viewer']

/**
 * Which GitHub repository may federate in.
 *
 * Resolved at bootstrap time from `gh api repos/<owner>/<repo>` rather than
 * declared in a checked-in file: `bootstrap.ts`'s AWS half already resolves
 * `owner/repo` per invocation (`resolveRepo`, defaulting to `gh repo view`) so
 * a community fork bootstraps itself rather than someone else's repository,
 * and the GCP half must not silently narrow that to one hardcoded fork.
 */
export type GitHubRepository = {
  issuer: string
  owner: string
  ownerId: string
  repository: string
  repositoryId: string
}

/**
 * The fence that makes federation safe at all.
 *
 * Without a condition any GitHub Actions job anywhere could present a token
 * this provider accepts. Pinned to the numeric ids rather than the names: an
 * owner or repository name can be transferred or re-created, an id cannot.
 */
export const attributeCondition = (github: GitHubRepository): string =>
  `assertion.repository_owner_id == '${github.ownerId}' && assertion.repository_id == '${github.repositoryId}'`

/**
 * Which claims become attributes a binding can name.
 *
 * `environment` and `ref` are the two claim shapes GitHub actually issues: a
 * job that declares an environment presents the first, and one that does
 * not — publish workflows running on push to main — presents the second.
 */
const ATTRIBUTE_MAPPING = [
  'google.subject=assertion.sub',
  'attribute.environment=assertion.environment',
  'attribute.ref=assertion.ref',
].join(',')

/** The gcloud calls this makes, split by what a failure means. */
type Gcloud = {
  /** Whether a resource is already there. Absence is an answer, not a failure. */
  present: (args: string[]) => Promise<boolean>
  /**
   * A question with an answer worth reading, whose failure is not an answer.
   *
   * Carries the CLI's own message, for the same reason `requireGhAuthenticated`
   * in `bootstrap.ts` keeps gh's: only gcloud's text separates a project this
   * identity cannot see from a session that needs refreshing. Swallowing it
   * reported `Reauthentication failed. cannot prompt during non-interactive
   * execution` — every call here carries `--quiet`, so it cannot prompt — as
   * "check that the project exists", which sends someone to the wrong place.
   *
   * An empty string still means "nothing", but only when gcloud said so.
   */
  read: (what: string, args: string[]) => Promise<string>
  /**
   * A question whose absence is an answer and whose failure is not.
   *
   * The difference from `read` is which of the two an empty result means: here
   * absence is expected and reported as `null`, and for the bootstrap record
   * the distinction is load-bearing — a transient failure read as "no record"
   * makes this file generate a second bucket name and strand every stored value
   * in the first one.
   */
  readOptional: (what: string, args: string[]) => Promise<string | null>
  /** A change. A non-zero exit fails the run, carrying the CLI's own message. */
  apply: (what: string, args: string[], stdin?: string) => Promise<void>
  /**
   * A change to an IAM policy, which is a read-modify-write and can lose.
   *
   * Every `add-iam-policy-binding` reads the policy, edits it and writes it
   * back against the ETag it read; another writer in between makes the write a
   * conflict. Retried here rather than at the call sites because it is a
   * property of the operation, not of any one binding — and this project is
   * shared with the other BoxLite apps, so a concurrent writer is ordinary.
   */
  applyPolicy: (what: string, args: string[]) => Promise<void>
}

/**
 * How many times a policy write is re-attempted, and how long it waits first.
 *
 * Doubling from a quarter second: 0.25 + 0.5 + 1 + 2, so four retries cost
 * under four seconds on the run that needs them and nothing on the runs that
 * do not. The shape Google's own message asks for — "retry the whole
 * read-modify-write with exponential backoff" — and finite for the same reason
 * the visibility budget is: a policy being rewritten continuously is not
 * something a longer loop fixes.
 */
const POLICY_WRITE_ATTEMPTS = 5
const POLICY_BACKOFF_MS = 250

/** What losing the race looks like, as opposed to being refused the write. */
const isPolicyConflict = (stderr: string): boolean =>
  /concurrent policy changes|subject of a conflict/i.test(stderr)

const gcloudFor = ({
  run,
  project,
  wait,
}: {
  run: Run
  project: string
  wait: (milliseconds: number) => Promise<unknown>
}): Gcloud => {
  // `--quiet` so nothing waits for a prompt in CI, and the project on every
  // call rather than relying on whatever `gcloud config` holds locally.
  const call = (args: string[], stdin?: string) =>
    run('gcloud', [...args, '--project', project, '--quiet'], stdin === undefined ? undefined : { stdin })
  return {
    async present(args) {
      return (await call(args)).code === 0
    },
    async read(what, args) {
      const result = await call(args)
      if (result.code !== 0) {
        throw new GcpBootstrapError(`${what}: ${result.stderr.trim() || `gcloud exited ${result.code}`}`)
      }
      return result.stdout.trim()
    },
    async readOptional(what, args) {
      const result = await call(args)
      if (result.code === 0) return result.stdout.trim()
      // gcloud says NOT_FOUND for a resource that is simply not there, and
      // something else for a permission problem or an unreachable API.
      if (/NOT_FOUND|was not found|does not exist/i.test(result.stderr)) return null
      throw new GcpBootstrapError(`${what}: ${result.stderr.trim() || `gcloud exited ${result.code}`}`)
    },
    async apply(what, args, stdin) {
      const result = await call(args, stdin)
      if (result.code === 0) return
      throw new GcpBootstrapError(`${what}: ${result.stderr.trim() || `gcloud exited ${result.code}`}`)
    },
    async applyPolicy(what, args) {
      let backoff = POLICY_BACKOFF_MS
      for (let attempt = 1; ; attempt += 1) {
        const result = await call(args)
        if (result.code === 0) return
        // Anything else is a refusal, and re-sending it would only repeat it.
        if (attempt === POLICY_WRITE_ATTEMPTS || !isPolicyConflict(result.stderr)) {
          throw new GcpBootstrapError(`${what}: ${result.stderr.trim() || `gcloud exited ${result.code}`}`)
        }
        await wait(backoff)
        backoff *= 2
      }
    },
  }
}

/** Turns on what is off, and says nothing about what was already on. */
const ensureServices = async ({ gcloud, log }: { gcloud: Gcloud; log: (line: string) => void }): Promise<void> => {
  log('==> services')
  const enabled = new Set(
    (await gcloud.read('reading which APIs are enabled', ['services', 'list', '--enabled', '--format=value(config.name)']))
      .split('\n')
      .filter(Boolean),
  )
  const missing = SERVICES.filter((service) => !enabled.has(service))
  if (missing.length === 0) {
    log(`    all ${SERVICES.length} already enabled`)
    return
  }
  // One call: enabling a service takes seconds and gcloud accepts the whole set.
  await gcloud.apply(`Could not enable ${missing.join(', ')}`, ['services', 'enable', ...missing])
  log(`    enabled ${missing.join(', ')}`)
}

/**
 * The bucket that holds Pulumi's state and mstage's store, and the record that
 * names it.
 *
 * Discovered before it is created: if the record already names a bucket, that
 * one is reconciled and kept. Generating a second name on a re-run would leave
 * every stored value behind in the first bucket while the record pointed at an
 * empty one — the failure would look like a stage that had never been
 * configured.
 */
const ensureStateBucket = async ({
  gcloud,
  region,
  log,
}: {
  gcloud: Gcloud
  region: string
  log: (line: string) => void
}): Promise<void> => {
  log(`==> ${BOOTSTRAP_SECRET}`)
  const recorded = await gcloud.readOptional(`Could not read ${BOOTSTRAP_SECRET}`, [
    'secrets',
    'versions',
    'access',
    'latest',
    '--secret',
    BOOTSTRAP_SECRET,
  ])
  let bucket: string | null = null
  if (recorded) {
    let parsed: { state?: string }
    try {
      parsed = JSON.parse(recorded)
    } catch {
      throw new GcpBootstrapError(`${BOOTSTRAP_SECRET} is not valid JSON. mstage reads {"state":"<bucket>"} from it.`)
    }
    if (!parsed.state) throw new GcpBootstrapError(`${BOOTSTRAP_SECRET} names no state bucket.`)
    bucket = parsed.state
    log('    already names a bucket')
  }

  if (!bucket) {
    // Not guessable, and not derived from the project: the name is the one
    // string that says where every stage's secrets live.
    bucket = `mstage-state-${randomBytes(8).toString('hex')}`
    log('    generating a new one')
  }

  if (await gcloud.present(['storage', 'buckets', 'describe', `gs://${bucket}`])) {
    log('    bucket already exists')
  } else {
    await gcloud.apply('Could not create the state bucket', [
      'storage',
      'buckets',
      'create',
      `gs://${bucket}`,
      `--location=${region}`,
      // No object ACLs: access is the bucket's IAM and nothing else, so a
      // mis-set ACL cannot open one object.
      '--uniform-bucket-level-access',
      '--public-access-prevention',
    ])
    log('    bucket created')
  }
  // Versioning is what makes a pinned read possible, and what makes a Pulumi
  // state overwrite recoverable.
  await gcloud.apply('Could not turn on versioning for the state bucket', [
    'storage',
    'buckets',
    'update',
    `gs://${bucket}`,
    '--versioning',
  ])
  log('    versioning on')

  if (!recorded) {
    await gcloud.apply(
      `Could not create ${BOOTSTRAP_SECRET}`,
      ['secrets', 'create', BOOTSTRAP_SECRET, '--replication-policy=automatic', '--data-file=-'],
      JSON.stringify({ state: bucket }),
    )
    log('    record written')
  }
}

/**
 * What the store is sealed with, created once and never replaced.
 *
 * A second version would not rotate anything — it would make every value
 * already in the store undecryptable, because the store is sealed with the
 * version that was current when it was written. So an existing secret is left
 * exactly alone.
 */
const ensurePassphrase = async ({
  gcloud,
  app,
  stage,
  log,
}: {
  gcloud: Gcloud
  app: string
  stage: string
  log: (line: string) => void
}): Promise<void> => {
  const name = `mstage-passphrase-${app}-${stage}`
  log(`==> ${name}`)
  if (await gcloud.present(['secrets', 'describe', name])) {
    log('    already exists, left alone')
    return
  }
  await gcloud.apply(
    `Could not create ${name}`,
    ['secrets', 'create', name, '--replication-policy=automatic', '--data-file=-'],
    // Through stdin, never argv: an argument is visible in the process table.
    randomBytes(32).toString('base64'),
  )
  log('    created')
}

/** The pool and the one provider in it that trusts GitHub's OIDC tokens. */
const ensurePool = async ({
  gcloud,
  pool: POOL,
  github,
  log,
}: {
  gcloud: Gcloud
  pool: string
  github: GitHubRepository
  log: (line: string) => void
}): Promise<void> => {
  const pool = ['iam', 'workload-identity-pools']
  log(`==> ${POOL}/${POOL_PROVIDER}`)

  if (!(await gcloud.present([...pool, 'describe', POOL, `--location=${POOL_LOCATION}`]))) {
    await gcloud.apply(`Could not create the ${POOL} pool`, [
      ...pool,
      'create',
      POOL,
      `--location=${POOL_LOCATION}`,
      '--display-name=BoxLite CI',
    ])
    log('    pool created')
  }

  const condition = attributeCondition(github)
  const provider = [...pool, 'providers']
  const settings = [
    `--location=${POOL_LOCATION}`,
    `--workload-identity-pool=${POOL}`,
    `--issuer-uri=${github.issuer}`,
    `--attribute-mapping=${ATTRIBUTE_MAPPING}`,
    `--attribute-condition=${condition}`,
    /*
     * No `--allowed-audiences`. An explicit list replaces GCP's default rather
     * than adding to it, and the default is the provider's own resource URL —
     * exactly what `google-github-actions/auth` requests when no `audience:`
     * input is given, as none is in `.github/workflows/mdeploy.yml` or
     * `mbuild.yml`. Pinning the `projects/-` spelling instead would reject
     * every token the action actually mints.
     */
  ]
  if (
    await gcloud.present([
      ...provider,
      'describe',
      POOL_PROVIDER,
      `--location=${POOL_LOCATION}`,
      `--workload-identity-pool=${POOL}`,
    ])
  ) {
    // Updated rather than skipped: the condition is the fence, and a rerun
    // against a repository whose owner/repo id changed has to reach GCP.
    await gcloud.apply(`Could not update the ${POOL_PROVIDER} provider`, [
      ...provider,
      'update-oidc',
      POOL_PROVIDER,
      ...settings,
    ])
    log('    provider updated')
  } else {
    await gcloud.apply(`Could not create the ${POOL_PROVIDER} provider`, [
      ...provider,
      'create-oidc',
      POOL_PROVIDER,
      ...settings,
    ])
    log('    provider created')
  }
}

const serviceAccountEmail = (id: string, project: string): string => `${id}@${project}.iam.gserviceaccount.com`

/**
 * A service account, reconciled by existence alone: nothing here would change one.
 *
 * `describe` takes the full email and `create` takes the bare id — the two
 * commands disagree, and gcloud rejects the other spelling rather than
 * answering "absent". Probing with the id would make every re-run try to
 * create an account that was already there, which is the opposite of the
 * reconcile this file promises.
 */
const ensureServiceAccount = async ({
  gcloud,
  id,
  email,
  description,
  log,
  wait,
}: {
  gcloud: Gcloud
  id: string
  email: string
  description: string
  log: (line: string) => void
  wait: (milliseconds: number) => Promise<unknown>
}): Promise<void> => {
  if (await gcloud.present(['iam', 'service-accounts', 'describe', email])) {
    log('    already exists')
    return
  }
  await gcloud.apply(`Could not create the ${id} service account`, [
    'iam',
    'service-accounts',
    'create',
    id,
    `--description=${description}`,
  ])
  log('    created')
  await waitUntilVisible({ gcloud, email, log, wait })
}

/**
 * How long to keep asking whether a new service account exists yet.
 *
 * Five reads a second apart. The observed gap was under one; the budget is
 * generous because the cost of waiting is a few seconds on the one run that
 * creates the account, and the cost of not waiting is a bootstrap that dies
 * halfway through with an account created and none of its roles granted.
 */
const VISIBILITY_READS = 5
const VISIBILITY_INTERVAL_MS = 1_000

/**
 * Waits for a just-created service account to be readable.
 *
 * `create` returns before the account is visible to the IAM policy API, so the
 * grant that follows can be refused with `Service account <email> does not
 * exist` — naming, as absent, the account the line above just made. It is a
 * propagation window and not a failure, but it is indistinguishable from one at
 * the call site, which is why it is closed here rather than reported.
 *
 * This is what stopped `bootstrapGcp` from being the reconcile its own comment
 * promises: a first run created the deployer, failed every role on it, and only
 * a second run — by which point the account was visible — completed. Silent
 * recovery by re-running is not the same as working.
 */
const waitUntilVisible = async ({
  gcloud,
  email,
  log,
  wait,
}: {
  gcloud: Gcloud
  email: string
  log: (line: string) => void
  wait: (milliseconds: number) => Promise<unknown>
}): Promise<void> => {
  for (let read = 0; read < VISIBILITY_READS; read += 1) {
    if (await gcloud.present(['iam', 'service-accounts', 'describe', email])) return
    await wait(VISIBILITY_INTERVAL_MS)
  }
  // Not thrown: the grant below reports its own refusal with the role it was
  // trying to attach, which says more than a timeout here would.
  log('    still not readable; the grants below may need a second run')
}

/** Project-level roles. `add-iam-policy-binding` is idempotent by design. */
const grantProjectRoles = async ({
  gcloud,
  project,
  email,
  roles,
  log,
}: {
  gcloud: Gcloud
  project: string
  email: string
  roles: string[]
  log: (line: string) => void
}): Promise<void> => {
  for (const role of roles) {
    await gcloud.applyPolicy(`Could not grant ${role} to ${email}`, [
      'projects',
      'add-iam-policy-binding',
      project,
      `--member=serviceAccount:${email}`,
      `--role=${role}`,
      // Without this gcloud prompts for a condition, which never returns in CI.
      '--condition=None',
    ])
  }
  log(`    ${roles.length} project roles granted`)
}

/**
 * Lets one federated principal act as one service account.
 *
 * `principalSet` rather than `principal`: the member is every token whose
 * mapped attribute has this value, which is what makes "any job in this
 * repository declaring environment dev" expressible at all.
 */
const allowImpersonation = async ({
  gcloud,
  email,
  projectNumber,
  pool: POOL,
  attribute,
  value,
}: {
  gcloud: Gcloud
  email: string
  projectNumber: string
  pool: string
  attribute: string
  value: string
}): Promise<void> => {
  const member =
    `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/${POOL_LOCATION}` +
    `/workloadIdentityPools/${POOL}/attribute.${attribute}/${value}`
  await gcloud.applyPolicy(`Could not let ${attribute}/${value} act as ${email}`, [
    'iam',
    'service-accounts',
    'add-iam-policy-binding',
    email,
    `--member=${member}`,
    '--role=roles/iam.workloadIdentityUser',
  ])
}

/**
 * The repository a stage's images are published into.
 *
 * `immutableTags` is `mbuild.config.json`'s declaration, carried here rather
 * than decided here, because this is the only moment it can be honoured: the
 * setting is fixed when the repository is created and there is no command that
 * changes it afterwards. A repository made without it is one where a deployed
 * commit tag can still be repointed under a running service — and mbuild refuses
 * to publish into that mismatch rather than quietly dropping the guarantee, so
 * getting it wrong here costs a repository that has to be deleted by hand.
 */
const ensureRepository = async ({
  gcloud,
  repository,
  region,
  immutableTags,
  log,
}: {
  gcloud: Gcloud
  repository: string
  region: string
  immutableTags: boolean
  log: (line: string) => void
}): Promise<void> => {
  log(`==> ${repository}`)
  const args = ['artifacts', 'repositories']
  if (await gcloud.present([...args, 'describe', repository, `--location=${region}`])) {
    log('    already exists')
    return
  }
  await gcloud.apply(`Could not create the ${repository} repository`, [
    ...args,
    'create',
    repository,
    '--repository-format=docker',
    `--location=${region}`,
    ...(immutableTags ? ['--immutable-tags'] : []),
    '--description=BoxLite’s api and otel-collector images',
  ])
  log(`    created${immutableTags ? ' with immutable tags' : ''}`)
}

/**
 * The bucket a build-mode runner binary is staged in.
 *
 * The bootstrap owns it for the ordering reason it owns the image repository:
 * `runner:build` puts an object there before any stack could consume one, so the
 * consumer cannot also create its own input. The name is composed rather than
 * recorded — `mdeploy/stack/runner-binary.ts` spells the same rule for the
 * address the hosts fetch and for the read grant they are given.
 *
 * Uniform access and public-access prevention for the same reason the state
 * bucket has them: the only way in is this project's IAM, and a binary every
 * host installs as root is not an object to leave one mis-set ACL away from
 * public.
 */
const ensureArtifactsBucket = async ({
  gcloud,
  bucket,
  region,
  log,
}: {
  gcloud: Gcloud
  bucket: string
  region: string
  log: (line: string) => void
}): Promise<void> => {
  log(`==> ${bucket}`)
  if (await gcloud.present(['storage', 'buckets', 'describe', `gs://${bucket}`])) {
    log('    already exists')
    return
  }
  await gcloud.apply('Could not create the runner artifacts bucket', [
    'storage',
    'buckets',
    'create',
    `gs://${bucket}`,
    `--location=${region}`,
    '--uniform-bucket-level-access',
    '--public-access-prevention',
  ])
  log('    created')
}

/** The stage a promotion into this one reads, and the two things it reads there. */
export type PromotionSource = {
  stage: string
  project: string
  /** Where `runner:promote` copies the staged binary from. */
  bucket: string
}

/**
 * Which stage's project this one's accounts have to be let into, if any.
 *
 * `mstage/config` checks that `promoteFrom` does not name its own stage and,
 * when the named stage is present, that it lives in the same cloud. What it
 * cannot check is that the name resolves at all: a CI job restores the
 * declarations it reaches and not the file, so prod's block routinely arrives
 * without dev's. A bootstrap reads a whole file, so here an unresolvable name
 * is a mistake and is refused — left to pass it would be a bootstrap that
 * silently granted nothing, discovered when prod promotes.
 *
 * `undefined` when the source shares this project: the accounts already hold
 * the project roles there, and a second binding saying so reads as a boundary
 * that is not one.
 */
export const promotionSourceFor = ({
  config,
  stage,
}: {
  config: {
    app: string
    /** The file the refusals name, so an operator knows which one to edit. */
    path: string
    stages: Record<string, { project?: string | null; promoteFrom?: string | null }>
  }
  stage: string
}): PromotionSource | undefined => {
  const from = config.stages[stage]?.promoteFrom
  if (!from) return undefined
  const source = config.stages[from]
  if (!source) {
    throw new GcpBootstrapError(
      `Stage "${stage}" promotes from "${from}" in ${config.path}, which declares no such stage. ` +
        'A promotion needs both ends declared in one file.',
    )
  }
  if (!source.project) throw new GcpBootstrapError(`Stage "${from}" declares no project in ${config.path}`)
  if (source.project === config.stages[stage]?.project) return undefined
  return {
    stage: from,
    project: source.project,
    bucket: gcpRunnerArtifactsBucket({ app: config.app, stage: from, project: source.project }),
  }
}

/**
 * What a promotion into this stage reads, granted in the stage it reads from.
 *
 * The only work this file does outside its own project, and the reason it has
 * to: a promotion is one session — the destination's, because that is the one
 * that writes — so the accounts doing the reading belong to the stage being
 * bootstrapped while the policies admitting them belong to the source. Neither
 * end can make this grant alone, and the destination is the end that knows both
 * account names, because it just created them.
 *
 * Two accounts, not one. The legs authenticate differently — `mbuild.yml`
 * federates `GCP_IMAGE_PUBLISHER` and `mrunner.yml` `GCP_DEPLOYER` — so a grant
 * to one of them leaves the other half of a promotion failing, which is the
 * shape this was written for.
 *
 * Reported rather than fatal when the source refuses the write. An operator who
 * administers this stage and not the source is an ordinary situation, and
 * failing here would throw away a bootstrap that otherwise completed; the two
 * commands are printed so whoever does hold that project can run them.
 */
const grantPromotionReads = async ({
  run,
  wait,
  source,
  deployerEmail,
  publisherEmail,
  log,
}: {
  run: Run
  wait: (milliseconds: number) => Promise<unknown>
  source: PromotionSource
  deployerEmail: string
  publisherEmail: string
  log: (line: string) => void
}): Promise<void> => {
  log(`==> ${source.stage} in ${source.project}, what a promotion reads`)
  // Its own client: `gcloudFor` puts `--project` on every call, and these are
  // the only calls this run makes against a project that is not the stage's.
  const gcloud = gcloudFor({ run, project: source.project, wait })
  const grants: { what: string; args: string[] }[] = [
    {
      /*
       * Project-wide, which is wider than the bucket grant below and stays that
       * way deliberately. This is the grant `mbuild promote` is known to work
       * under — the pull, and the `artifacts docker images list` that decides
       * whether there is anything to pull — and narrowing it to the one
       * repository is a change that has to be proved against a real registry
       * rather than assumed here.
       */
      what: `granting ${publisherEmail} read on ${source.project}`,
      args: [
        'projects',
        'add-iam-policy-binding',
        source.project,
        `--member=serviceAccount:${publisherEmail}`,
        '--role=roles/artifactregistry.reader',
        // Without this gcloud prompts for a condition, which never returns in CI.
        '--condition=None',
      ],
    },
    {
      /*
       * One bucket, not the project: this is the whole of what `runner:promote`
       * touches at the source. Object reads only — `runner:promote` lists the
       * prefix and copies what is under it, and asks the bucket itself nothing,
       * which is what keeps this off `storage.buckets.get` and so off every
       * role wider than this one.
       */
      what: `granting ${deployerEmail} read on gs://${source.bucket}`,
      args: [
        'storage',
        'buckets',
        'add-iam-policy-binding',
        `gs://${source.bucket}`,
        `--member=serviceAccount:${deployerEmail}`,
        '--role=roles/storage.objectViewer',
      ],
    },
  ]

  const refused: string[] = []
  for (const grant of grants) {
    try {
      await gcloud.applyPolicy(`Could not ${grant.what}`, grant.args)
    } catch (error) {
      refused.push(`gcloud ${grant.args.join(' ')} --project ${source.project}`)
      log(`    ${grant.what}: ${(error as Error).message}`)
    }
  }
  if (refused.length === 0) {
    log('    both grants applied')
    return
  }
  log(`    ${refused.length} of ${grants.length} refused. Run these where ${source.project} can be administered:`)
  for (const command of refused) log(`      ${command}`)
}

/**
 * What turns the OS Config agent on, for every instance in the project.
 *
 * Project-wide rather than per instance, and that is the point: the runner
 * hosts are `protect: true` with their boot script in `ignoreChanges`, so a
 * deploy can change nothing about a host that already exists — but common
 * project metadata reaches the agent on machines that are already running, with
 * no restart and nothing entering them.
 *
 * Merged, never replaced: `add-metadata` leaves every other key alone, where
 * `gcloud compute project-info add-metadata --metadata-from-file` semantics for
 * a whole map would drop the SSH keys and anything else the project carries.
 */
const ensureOsConfigAgent = async ({
  gcloud,
  log,
}: {
  gcloud: Gcloud
  log: (line: string) => void
}): Promise<void> => {
  log('==> enable-osconfig')
  await gcloud.apply('Could not turn the OS Config agent on for the project', [
    'compute',
    'project-info',
    'add-metadata',
    '--metadata=enable-osconfig=TRUE',
  ])
  log('    on, project-wide')
}

export type GcpBootstrapInput = {
  run: Run
  /** The project this stage lives in, from `mstage.config.json`. */
  project: string
  /** Where the stage lives, which is also where its bucket and repository go. */
  region: string
  /**
   * The app in full, and the only thing it names here: the passphrase secret,
   * whose spelling is mstage's — `gcp-backend.ts` composes
   * `mstage-passphrase-<app>-<stage>` to read the store back. Every identity
   * below takes `appShort` instead, because those have a length budget.
   */
  app: string
  /** The app abbreviated: what `naming` names the pool and the identities from. */
  appShort: string
  stage: string
  /** Which docker repository this stage publishes into, from `mbuild.config.json`. */
  repository: string
  /** Whether that repository's tags are fixed once written. Same file's declaration. */
  immutableTags: boolean
  github: GitHubRepository
  log: (line: string) => void
  /**
   * The stage a promotion into this one reads from, when it lives in another
   * project. Absent for a stage nothing is promoted into, and absent when the
   * source shares this project — there the accounts already hold what they
   * need, and a second binding would say nothing.
   */
  promotionSource?: PromotionSource
  /**
   * How this waits out a propagation window. Injected for the same reason
   * `run` is: a test proves the retry happens without spending the seconds.
   */
  wait?: (milliseconds: number) => Promise<unknown>
}

/** What was created, for the caller to wire into GitHub. gcp.ts never calls `gh` itself. */
export type GcpBootstrapResult = {
  workloadIdentityProvider: string
  deployerEmail: string
  publisherEmail: string
}

/**
 * One invocation: everything a `mdeploy`/`mbuild` run on this stage needs and
 * cannot create for itself.
 *
 * Returns what it made rather than printing `gh` commands: `bootstrap.ts`
 * already writes the AWS deploy role's ARN straight into the GitHub
 * Environment (`ghEnvironmentVariableSet`) instead of asking the operator to
 * paste it, and the GCP half follows the same, already-established shape
 * instead of introducing a second UX for the same command.
 */
export const bootstrapGcp = async ({
  run,
  project,
  region,
  app,
  appShort,
  stage,
  repository,
  immutableTags,
  github,
  log,
  promotionSource,
  wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: GcpBootstrapInput): Promise<GcpBootstrapResult> => {
  const gcloud = gcloudFor({ run, project, wait })

  /*
   * Needed for every principalSet below, and the first call this file makes.
   *
   * Being first is deliberate twice over: a project these credentials cannot
   * act on should fail before anything is created, and this is also where an
   * unusable gcloud session surfaces — so the failure carries gcloud's own
   * words rather than this file's guess about which of the two it was.
   */
  const projectNumber = await gcloud.read(
    `reading the number of project ${project}`,
    ['projects', 'describe', project, '--format=value(projectNumber)'],
  )
  if (!projectNumber) {
    throw new GcpBootstrapError(
      `gcloud described project ${project} but printed no project number. ` +
        `Read it directly with: gcloud projects describe ${project} --format='value(projectNumber)'`,
    )
  }

  const pool = poolFor({ appShort })

  await ensureServices({ gcloud, log })
  await ensureStateBucket({ gcloud, region, log })
  await ensurePassphrase({ gcloud, app, stage, log })
  await ensurePool({ gcloud, pool, github, log })

  const deployer = identityFor({ appShort, stage, action: 'deploy' })
  const deployerEmail = serviceAccountEmail(deployer, project)
  log(`==> ${deployer}`)
  await ensureServiceAccount({
    gcloud,
    id: deployer,
    email: deployerEmail,
    description: `Deploys BoxLite's ${stage} stage, assumed by GitHub Actions in the ${stage} environment`,
    log,
    wait,
  })
  await grantProjectRoles({ gcloud, project, email: deployerEmail, roles: DEPLOYER_ROLES, log })
  // One stage, one environment: the same claim the AWS deploy role trusts.
  await allowImpersonation({ gcloud, email: deployerEmail, projectNumber, pool, attribute: 'environment', value: stage })
  log(`    environment ${stage} may act as it`)

  const publisher = identityFor({ appShort, action: 'publish' })
  const publisherEmail = serviceAccountEmail(publisher, project)
  log(`==> ${publisher}`)
  await ensureServiceAccount({
    gcloud,
    id: publisher,
    email: publisherEmail,
    description: "Publishes BoxLite's images, assumed by GitHub Actions",
    log,
    wait,
  })
  await grantProjectRoles({ gcloud, project, email: publisherEmail, roles: PUBLISHER_ROLES, log })
  /*
   * Both claim shapes, matching mbuild.yml/publish-image.yml's own two
   * consumers: a stage publish declares `environment: <stage>`, a main-branch
   * publish declares none and arrives as a ref. One role serves every stage,
   * so bootstrapping a second GCP stage adds that stage's binding and
   * reapplies the ref one.
   */
  await allowImpersonation({ gcloud, email: publisherEmail, projectNumber, pool, attribute: 'ref', value: 'refs/heads/main' })
  await allowImpersonation({ gcloud, email: publisherEmail, projectNumber, pool, attribute: 'environment', value: stage })
  log(`    refs/heads/main and environment ${stage} may act as it`)

  await ensureRepository({ gcloud, repository, region, immutableTags, log })
  await ensureOsConfigAgent({ gcloud, log })
  await ensureArtifactsBucket({
    gcloud,
    bucket: gcpRunnerArtifactsBucket({ app, stage, project }),
    region,
    log,
  })

  // Last, because it is the only step that reaches outside this project and
  // both accounts it names have to exist before anything can be granted to them.
  if (promotionSource) {
    await grantPromotionReads({ run, wait, source: promotionSource, deployerEmail, publisherEmail, log })
  }

  log('')
  log('The state bucket is deliberately not returned; mstage reads it from')
  log(`${BOOTSTRAP_SECRET} and nothing else needs to know its name.`)

  return {
    workloadIdentityProvider: `projects/${projectNumber}/locations/${POOL_LOCATION}/workloadIdentityPools/${pool}/providers/${POOL_PROVIDER}`,
    deployerEmail,
    publisherEmail,
  }
}
