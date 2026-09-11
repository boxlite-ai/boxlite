/*
 * Two ways an image reaches a stage's registry: built there, or promoted there.
 *
 * `publish` builds every artifact at one commit and uploads it, in this order:
 *   ensure repository   a first publish into a fresh account fails on push otherwise
 *   already published?  immutable tags make a re-push fail, so a re-run of a
 *                       green build is recognised before anything is built
 *   audit               nothing ships carrying a high-severity advisory. Runs
 *                       inside the loop so a re-publish that builds nothing is
 *                       not audited, and `promote` has no such step at all
 *   build, push         the commit is passed in as REVISION so the image can
 *                       name itself
 *   scan gate           better a published image nobody may deploy than a
 *                       deployed image nobody scanned
 *
 * `promote` moves an already-built commit between registries. It never builds:
 * the bytes that ran in dev are the bytes that run in prod. ECR shares no
 * layers between repositories, so it is a pull, a re-tag and a push.
 *
 * `verifyPublished` only asks whether a registry holds every artifact at a
 * commit, and reports it. A deploy asks before it applies anything.
 *
 * Every external call goes through the injected `run`, so the whole sequence is
 * testable without a registry, a daemon or credentials.
 */

import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BuildConfig, ScanPolicy, ScanSeverity } from './config.ts'
import { addressFor, assertTag, type Registry } from './address.ts'

export class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

/**
 * The scan gate's refusal, which a caller must not retry.
 *
 * Every other `PublishError` is a push, a token endpoint or a registry API, all
 * of which fail transiently. A scan finding is about the image's own contents,
 * so asking again returns it again. Carried out to the exit code in
 * `bin/mbuild.ts`, because the caller that has to stop retrying is a shell.
 */
export class ScanRefusedError extends PublishError {
  constructor(message: string) {
    super(message)
    this.name = 'ScanRefusedError'
  }
}

/** One external command. Non-zero exit is reported, never thrown away. */
export type RunResult = { code: number; stdout: string; stderr: string }
/**
 * `stdin` passes a secret to a command without putting it in argv. `echo`
 * streams output to the log, and is set only for the commands that take
 * minutes — elsewhere the output is a password or a document to parse.
 */
export type RunOptions = { stdin?: string; echo?: boolean }
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>

/** Time, injected so a test spends a scan's budget without spending the time. */
export type Clock = { now: () => number; wait: (milliseconds: number) => Promise<unknown> }
const systemClock: Clock = { now: Date.now, wait: sleep }

/** How often an unanswered scan is asked again; `aws ecr wait` polls at this cadence. */
const SCAN_POLL_SECONDS = 5

/**
 * The architecture every runtime this publishes for runs on.
 *
 * Pinned rather than left to the builder's host, and it is the host that makes
 * this necessary: `docker build` targets the machine it runs on, which is
 * amd64 on a CI runner and arm64 on an Apple Silicon workstation. Cloud Run
 * runs amd64 only, and an ECS task definition that declares no
 * `runtimePlatform` gets Fargate's x86_64 default — an arm64 image satisfies
 * neither.
 *
 * Measured, which is why this is a constant rather than a note: a local
 * publish from an arm64 workstation pushed an arm64 image, the tag was
 * accepted, and the revision built from it died at `failed to load
 * /usr/local/bin/docker-entrypoint.sh: exec format error`, with nothing before
 * that point naming an architecture. Immutability then cut both ways — the
 * wrong bytes took that commit's tag permanently, and the property that made
 * it permanent also refused the cleanup: `images delete --delete-tags` answers
 * `FAILED_PRECONDITION: ... the repository has enabled tag immutability`, and
 * without that flag `cannot delete image ... because it is tagged`. A burned
 * tag is not removable while immutability is on; the remedy is a new commit.
 */
const RUNTIME_PLATFORM = 'linux/amd64'

export type PublishOutcome = {
  artifact: string
  address: string
  /** False when the commit was already there and nothing was built or moved. */
  built: boolean
}

/**
 * What a registry says about one image's scan right now. `pending` covers both
 * "no scan registered yet" and "still running" — a scan is registered only
 * after the push returns. Neither is a failure; `failed` is.
 */
type ScanReport =
  | { state: 'pending'; detail: string }
  | { state: 'complete'; counts: Record<string, number> }
  | { state: 'failed'; detail: string }

type Registrar = {
  ensureRepository: () => Promise<void>
  isPublished: (artifact: string, tag: string) => Promise<boolean>
  login: () => Promise<void>
  scanReport: (artifact: string, tag: string) => Promise<ScanReport>
}

/*
 * "Does not hold this" and "did not answer" are different facts, and only the
 * first belongs in a boolean. `publish` and a deploy's preflight read as
 * different identities, so a missing grant arrives here as a failed read;
 * answered `false` it would send the reader off to republish existing images.
 */
const ECR_IMAGE_ABSENT = /ImageNotFoundException/

const unreadable = ({ result, address }: { result: RunResult; address: string }): PublishError =>
  new PublishError(
    `Could not tell whether ${address} is published: ${
      result.stderr.trim() || result.stdout.trim() || `the registry read exited ${result.code}`
    }`,
  )

const ecrRegistrar = ({
  run,
  config,
  stage,
  registry,
}: {
  run: Run
  config: BuildConfig
  stage: string
  registry: Extract<Registry, { kind: 'ecr' }>
}): Registrar => {
  const declared = config.stages[stage]!.registry
  const aws = async (args: string[]): Promise<RunResult> => run('aws', [...args, '--region', registry.region])
  return {
    async ensureRepository() {
      const existing = await aws(['ecr', 'describe-repositories', '--repository-names', registry.repository])
      if (existing.code === 0) return
      // Immutable tags make a published commit mean exact bytes; scan on push
      // gives the gate below something to read.
      const created = await aws([
        'ecr',
        'create-repository',
        '--repository-name',
        registry.repository,
        '--image-tag-mutability',
        declared.immutableTags ? 'IMMUTABLE' : 'MUTABLE',
        '--image-scanning-configuration',
        `scanOnPush=${declared.scanOnPush}`,
      ])
      if (created.code !== 0) {
        throw new PublishError(`Could not create ${registry.repository}: ${created.stderr.trim()}`)
      }
    },
    async isPublished(artifact, tag) {
      const found = await aws([
        'ecr',
        'describe-images',
        '--repository-name',
        registry.repository,
        '--image-ids',
        `imageTag=${tag}-${artifact}`,
      ])
      if (found.code === 0) return true
      if (ECR_IMAGE_ABSENT.test(found.stderr)) return false
      throw unreadable({ result: found, address: addressFor({ config, registry, artifact, tag }) })
    },
    async login() {
      const password = await aws(['ecr', 'get-login-password'])
      if (password.code !== 0) throw new PublishError(`Could not obtain a registry password: ${password.stderr.trim()}`)
      // Through stdin, never argv, which the process table exposes. An unfed
      // `--password-stdin` makes docker prompt and fail on the absent terminal.
      const login = await run('docker', ['login', '--username', 'AWS', '--password-stdin', registry.host], {
        stdin: password.stdout.trim(),
      })
      if (login.code !== 0) throw new PublishError(`Could not log in to ${registry.host}: ${login.stderr.trim()}`)
    },
    async scanReport(artifact, tag) {
      const answer = await aws([
        'ecr',
        'describe-image-scan-findings',
        '--repository-name',
        registry.repository,
        '--image-id',
        `imageTag=${tag}-${artifact}`,
        // Status and counts together: absent counts mean "found nothing" once
        // COMPLETE and "has not looked yet" until then — opposite answers.
        '--query',
        '{status: imageScanStatus.status, detail: imageScanStatus.description, counts: imageScanFindings.findingSeverityCounts}',
        // JSON, not text: a still-running scan carries no `imageScanFindings`,
        // and the CLI's text formatter dies assigning result keys into that null.
        '--output',
        'json',
      ])
      if (answer.code !== 0) {
        // The image exists before its scan does; this read can arrive first.
        if (answer.stderr.includes('ScanNotFoundException')) return { state: 'pending', detail: 'not registered yet' }
        throw new PublishError(`Could not read scan findings: ${answer.stderr.trim()}`)
      }
      let described: { status?: string; detail?: string; counts?: Record<string, number> | null }
      try {
        described = (JSON.parse(answer.stdout || '{}') ?? {}) as typeof described
      } catch {
        throw new PublishError('Scan findings were not valid JSON')
      }
      const status = described.status ?? 'UNKNOWN'
      switch (status) {
        // COMPLETE from a scan on push, ACTIVE from continuous scanning.
        // Enhanced scanning is registry-wide, so either can arrive unannounced.
        case 'COMPLETE':
        case 'ACTIVE':
          return { state: 'complete', counts: described.counts ?? {} }
        case 'IN_PROGRESS':
        case 'PENDING':
          return { state: 'pending', detail: status }
        default:
          // Terminal — usually an unsupported image. Waiting out the budget
          // would only replace ECR's reason with a timeout.
          return { state: 'failed', detail: described.detail ? `${status}: ${described.detail}` : status }
      }
    },
  }
}

/**
 * Artifact Registry, which answers the same four questions differently.
 *
 * One repository per artifact, so the address carries the artifact in the path
 * and the tag is just the commit (`address.ts` writes both shapes).
 *
 * Scanning is not part of a push: Artifact Analysis scans continuously and
 * answers per occurrence, so the gate reads occurrences and never reports
 * pending. With analysis disabled the query returns nothing, which reads as no
 * findings — `scanOnPush` is what keeps this gate honest. ECR instead reads a
 * missing scan as pending and fails on a spent budget.
 */
const artifactRegistryRegistrar = ({
  run,
  config,
  stage,
  registry,
}: {
  run: Run
  config: BuildConfig
  stage: string
  registry: Extract<Registry, { kind: 'artifact-registry' }>
}): Registrar => {
  const declared = config.stages[stage]!.registry
  const region = registry.host.replace(/-docker\.pkg\.dev$/, '')
  const gcloud = async (args: string[]): Promise<RunResult> =>
    run('gcloud', [...args, '--project', registry.project, '--quiet'])
  const path = `${registry.host}/${registry.project}/${registry.repository}`
  return {
    async ensureRepository() {
      // Answers both questions at once: is it there, and does it match what
      // the stage declared. Tag immutability is fixed at creation, so a
      // repository predating the declaration cannot be brought to it. The
      // field is absent rather than false when unset.
      const existing = await gcloud([
        'artifacts',
        'repositories',
        'describe',
        registry.repository,
        '--location',
        region,
        '--format=value(dockerConfig.immutableTags)',
      ])
      if (existing.code === 0) {
        if (declared.immutableTags && existing.stdout.trim() !== 'True') {
          throw new PublishError(
            `${registry.repository} has mutable tags and this stage declares immutableTags. ` +
              'That setting is fixed at creation, so it cannot be corrected here.',
          )
        }
        return
      }
      const created = await gcloud([
        'artifacts',
        'repositories',
        'create',
        registry.repository,
        '--location',
        region,
        '--repository-format',
        'docker',
        // The same declaration ECR reads as IMMUTABLE. Nothing here addresses
        // an image by digest, so this alone makes a commit tag mean exact bytes.
        ...(declared.immutableTags ? ['--immutable-tags'] : []),
      ])
      if (created.code !== 0) {
        throw new PublishError(`Could not create ${registry.repository}: ${created.stderr.trim()}`)
      }
    },
    /*
     * `list`, not `describe`. On a pkg.dev repository `describe` always reaches
     * Container Analysis (google-cloud-sdk `command_lib/artifacts/docker_util.py`),
     * so it would make every caller need read on vulnerability metadata too.
     *
     * It also spells absence as an empty page rather than an error, separating
     * "not there" from "could not tell" without matching on message text.
     */
    async isPublished(artifact, tag) {
      const found = await gcloud([
        'artifacts',
        'docker',
        'images',
        'list',
        `${path}/${artifact}`,
        '--include-tags',
        `--filter=tags:${tag}`,
        '--format=value(version)',
      ])
      if (found.code !== 0) {
        throw unreadable({ result: found, address: addressFor({ config, registry, artifact, tag }) })
      }
      // Banner and warnings go to stderr, so an empty page is empty here.
      return found.stdout.trim() !== ''
    },
    async login() {
      // No password to fetch: the credential helper reads ambient ADC each
      // time, so nothing here expires between this call and the push.
      const configured = await run('gcloud', ['auth', 'configure-docker', registry.host, '--quiet'])
      if (configured.code !== 0) {
        throw new PublishError(`Could not log in to ${registry.host}: ${configured.stderr.trim()}`)
      }
    },
    async scanReport(artifact, tag) {
      const answer = await gcloud([
        'artifacts',
        'docker',
        'images',
        'describe',
        `${path}/${artifact}:${tag}`,
        '--show-package-vulnerability',
        '--format',
        'json',
      ])
      if (answer.code !== 0) throw new PublishError(`Could not read scan findings: ${answer.stderr.trim()}`)
      let described: { package_vulnerability_summary?: { vulnerabilities?: Record<string, unknown[]> } }
      try {
        described = JSON.parse(answer.stdout || '{}') ?? {}
      } catch {
        throw new PublishError('Scan findings were not valid JSON')
      }
      // One entry per occurrence; the gate counts by severity, so tally here.
      const vulnerabilities = described.package_vulnerability_summary?.vulnerabilities ?? {}
      // Never pending: these are the occurrences that exist now.
      return {
        state: 'complete',
        counts: Object.fromEntries(
          Object.entries(vulnerabilities).map(([severity, occurrences]) => [severity, occurrences.length]),
        ),
      }
    },
  }
}

const registrarFor = ({
  run,
  config,
  stage,
  registry,
}: {
  run: Run
  config: BuildConfig
  stage: string
  registry: Registry
}): Registrar => {
  switch (registry.kind) {
    case 'ecr':
      return ecrRegistrar({ run, config, stage, registry })
    case 'artifact-registry':
      return artifactRegistryRegistrar({ run, config, stage, registry })
  }
}

const blockingFindings = (counts: Record<string, number>, blockOn: ScanSeverity[]): string[] =>
  blockOn.filter((severity) => (counts[severity] ?? 0) > 0).map((severity) => `${counts[severity]} ${severity}`)

/**
 * The artifacts a registry does not hold at one commit, in declared order.
 * Names rather than a boolean, because both callers report which one is missing.
 */
const missingFrom = async ({
  registrar,
  artifacts,
  tag,
}: {
  registrar: Registrar
  artifacts: string[]
  tag: string
}): Promise<string[]> => {
  const missing: string[] = []
  for (const artifact of artifacts) {
    if (!(await registrar.isPublished(artifact, tag))) missing.push(artifact)
  }
  return missing
}

/**
 * One image's severity counts, waited for.
 *
 * An unanswered registry is not an image with nothing found — reading it as one
 * lets an unscanned image through. Reading it as a failure is the opposite
 * mistake. So pending is asked again, for `scan.timeoutSeconds`.
 */
const awaitScanCounts = async ({
  registrar,
  artifact,
  address,
  tag,
  timeoutSeconds,
  clock,
  log,
}: {
  registrar: Registrar
  artifact: string
  address: string
  tag: string
  timeoutSeconds: number
  clock: Clock
  log: (line: string) => void
}): Promise<Record<string, number>> => {
  // A deadline, not a poll count: the reads take time, so fixed steps would
  // not spend the budget the config declared. The last wait is whatever is
  // left, so a budget under one interval still buys a second read.
  const deadline = clock.now() + timeoutSeconds * 1_000
  let announced = false
  for (;;) {
    const report = await registrar.scanReport(artifact, tag)
    if (report.state === 'complete') return report.counts
    if (report.state === 'failed') throw new PublishError(`${address} was not scanned: ${report.detail}`)
    const remaining = deadline - clock.now()
    if (remaining <= 0) throw new PublishError(`${address} had no scan result after ${timeoutSeconds}s`)
    // Once, not per poll — but at least once, or the wait looks like a hang.
    if (!announced) {
      log(`Waiting up to ${timeoutSeconds}s for the scan of ${address} (${report.detail})`)
      announced = true
    }
    await clock.wait(Math.min(SCAN_POLL_SECONDS * 1_000, remaining))
  }
}

/**
 * The receiving stage's policy, not the repository's: what a stage refuses is
 * declared beside the registry it publishes into, so prod can be stricter than
 * dev. On a promotion this is the destination's, because the destination is
 * what has to run the image.
 */
const assertNoBlockingFindings = async ({
  registrar,
  scan,
  outcomes,
  tag,
  clock,
  log,
}: {
  registrar: Registrar
  scan: ScanPolicy
  outcomes: PublishOutcome[]
  tag: string
  clock: Clock
  log: (line: string) => void
}): Promise<void> => {
  for (const { artifact, address } of outcomes) {
    const counts = await awaitScanCounts({
      registrar,
      artifact,
      address,
      tag,
      timeoutSeconds: scan.timeoutSeconds,
      clock,
      log,
    })
    const blocking = blockingFindings(counts, scan.blockOn)
    if (blocking.length > 0) throw new ScanRefusedError(`${address} has ${blocking.join(' and ')} findings`)
  }
}

/**
 * What the images are allowed to carry, checked before one is built.
 *
 * `--omit=dev` because the question is what ships. `--audit-level=high` is the
 * threshold `ci.yml` already uses, and this is the second place that needs it:
 * a hand-dispatched publish names its own ref, so passing CI is not something
 * it can assume.
 *
 * Called from inside the build loop, because whether anything needs building is
 * only knowable once the registry has answered `isPublished`. A doomed build
 * therefore costs a repository and a login first; what that buys is that a
 * re-publish with nothing to build is not audited at all.
 */
const assertNoHighSeverityAdvisories = async ({
  config,
  run,
  log,
}: {
  config: BuildConfig
  run: Run
  log: (line: string) => void
}): Promise<void> => {
  log('Auditing the dependencies that ship')
  // `--prefix` rather than a working directory: `RunOptions` carries no cwd.
  // Not echoed — that is reserved for the commands that take minutes — so what
  // npm said travels in the error instead.
  const audited = await run('npm', ['--prefix', config.repository, 'audit', '--audit-level=high', '--omit=dev'])
  if (audited.code === 0) return
  // Not "advisories were found": a non-zero exit is also how npm reports that
  // it could not audit at all — no lockfile, no registry — and that arrives on
  // stderr with stdout empty. Both streams, so the reason is always carried.
  const said = [audited.stdout.trim(), audited.stderr.trim()].filter((stream) => stream.length > 0).join('\n')
  throw new PublishError(`npm audit did not pass, so no image was built.\n${said}`)
}

export const publish = async ({
  config,
  stage,
  registry,
  tag,
  run,
  log = console.log,
  clock = systemClock,
}: {
  config: BuildConfig
  stage: string
  registry: Registry
  tag: string
  run: Run
  log?: (line: string) => void
  clock?: Clock
}): Promise<PublishOutcome[]> => {
  assertTag(tag)
  /*
   * Audited once, the first time a build is actually going to happen. Not up
   * front: a re-publish whose artifacts are all present builds nothing, and
   * gating that on today's advisories would hold an old image against a new
   * answer — the same reason `promote` does not audit at all.
   */
  let audited = false
  const auditOnce = async (): Promise<void> => {
    if (audited) return
    await assertNoHighSeverityAdvisories({ config, run, log })
    audited = true
  }
  const registrar = registrarFor({ run, config, stage, registry })
  await registrar.ensureRepository()
  await registrar.login()

  const outcomes: PublishOutcome[] = []
  for (const [artifact, declared] of Object.entries(config.artifacts)) {
    // Resolved against the repository, so the same command builds the same
    // bytes from apps/infra, from the root, or from a workflow step.
    const dockerfile = join(config.repository, declared.dockerfile)
    const context = join(config.repository, declared.context)
    const address = addressFor({ config, registry, artifact, tag })
    if (await registrar.isPublished(artifact, tag)) {
      log(`${address} is already published; nothing to do.`)
      outcomes.push({ artifact, address, built: false })
      continue
    }
    await auditOnce()
    // Named before it starts and echoed while it runs: these are the two long
    // commands, so silence here is silence for as long as the build takes.
    log(`Building ${artifact} from ${dockerfile} as ${address}`)
    const built = await run(
      'docker',
      ['build', '--platform', RUNTIME_PLATFORM, '--build-arg', `REVISION=${tag}`, '-f', dockerfile, '-t', address, context],
      { echo: true },
    )
    // The exit code, not the output: docker already wrote the reason above.
    if (built.code !== 0) throw new PublishError(`Could not build ${artifact}: docker build exited ${built.code}`)
    log(`Pushing ${address}`)
    const pushed = await run('docker', ['push', address], { echo: true })
    if (pushed.code !== 0) throw new PublishError(`Could not push ${address}: docker push exited ${pushed.code}`)
    log(`Pushed ${address}`)
    outcomes.push({ artifact, address, built: true })
  }

  await assertNoBlockingFindings({ registrar, scan: config.stages[stage]!.scan, outcomes, tag, clock, log })
  return outcomes
}

/** Where one artifact sits, for a commit the registry already holds. */
export type PublishedImage = { artifact: string; address: string }

/**
 * Refuse unless a stage's registry holds every artifact at one commit, and
 * report where they sit.
 *
 * A pure read — nothing created, logged in to or built — so it is cheap enough
 * to run before a deploy commits to anything. The addresses come from
 * `addressFor`, the same function the deploy resolves through, or this could
 * check one address and deploy another.
 */
export const verifyPublished = async ({
  config,
  stage,
  registry,
  tag,
  run,
}: {
  config: BuildConfig
  stage: string
  registry: Registry
  tag: string
  run: Run
}): Promise<PublishedImage[]> => {
  assertTag(tag)
  const registrar = registrarFor({ run, config, stage, registry })
  const artifacts = Object.keys(config.artifacts)
  const missing = await missingFrom({ registrar, artifacts, tag })
  if (missing.length > 0) {
    // The address, not the artifact name: it carries the repository and tag a
    // person compares against the publish that should have written them.
    const addresses = missing.map((artifact) => addressFor({ config, registry, artifact, tag }))
    throw new PublishError(`${stage} does not hold ${addresses.join(', ')}`)
  }
  return artifacts.map((artifact) => ({ artifact, address: addressFor({ config, registry, artifact, tag }) }))
}

export type PromoteOutcome = PublishOutcome & { from: string }

/**
 * Move a commit from one stage's registry to another's.
 *
 * The source must hold every artifact — half a release is a version that cannot
 * start — and that is checked before anything is pulled.
 */
export const promote = async ({
  config,
  tag,
  from,
  to,
  run,
  log = console.log,
  clock = systemClock,
}: {
  config: BuildConfig
  tag: string
  from: { stage: string; registry: Registry }
  to: { stage: string; registry: Registry }
  run: Run
  log?: (line: string) => void
  clock?: Clock
}): Promise<PromoteOutcome[]> => {
  assertTag(tag)
  if (from.stage === to.stage) throw new PublishError(`Promoting "${from.stage}" to itself would do nothing`)

  const source = registrarFor({ run, config, stage: from.stage, registry: from.registry })
  const destination = registrarFor({ run, config, stage: to.stage, registry: to.registry })

  const artifacts = Object.keys(config.artifacts)
  const missing = await missingFrom({ registrar: source, artifacts, tag })
  if (missing.length > 0) {
    throw new PublishError(`${from.stage} does not hold ${missing.join(', ')} at ${tag}; nothing was promoted`)
  }

  await destination.ensureRepository()
  await source.login()
  await destination.login()

  const outcomes: PromoteOutcome[] = []
  for (const artifact of artifacts) {
    const sourceAddress = addressFor({ config, registry: from.registry, artifact, tag })
    const address = addressFor({ config, registry: to.registry, artifact, tag })
    if (await destination.isPublished(artifact, tag)) {
      log(`${address} is already there; nothing to do.`)
      outcomes.push({ artifact, address, from: sourceAddress, built: false })
      continue
    }
    /*
     * Pull, re-tag, push: ECR shares no layers between repositories, so there
     * is no manifest-only copy. Echoed, because they move whole images.
     *
     * The pull names the architecture for the reason the build does, and this
     * is the worse place to miss it: `docker pull` of a multi-arch address
     * resolves to the *host's* variant, so a promotion from an arm64
     * workstation would carry that variant into the receiving stage — which is
     * the one thing promoting rather than rebuilding exists to prevent.
     */
    log(`Pulling ${sourceAddress}`)
    const pulled = await run('docker', ['pull', '--platform', RUNTIME_PLATFORM, sourceAddress], { echo: true })
    if (pulled.code !== 0) throw new PublishError(`Could not pull ${sourceAddress}: docker pull exited ${pulled.code}`)
    const tagged = await run('docker', ['tag', sourceAddress, address])
    if (tagged.code !== 0) throw new PublishError(`Could not tag ${address}: ${tagged.stderr.trim()}`)
    log(`Pushing ${address}`)
    const pushed = await run('docker', ['push', address], { echo: true })
    if (pushed.code !== 0) throw new PublishError(`Could not push ${address}: docker push exited ${pushed.code}`)
    log(`Promoted ${sourceAddress} to ${address}`)
    outcomes.push({ artifact, address, from: sourceAddress, built: true })
  }

  // The destination's threshold decides whether the receiving stage may run it.
  await assertNoBlockingFindings({
    registrar: destination,
    scan: config.stages[to.stage]!.scan,
    outcomes,
    tag,
    clock,
    log,
  })
  return outcomes
}
