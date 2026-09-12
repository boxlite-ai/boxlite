/*
 * `npm run runner:build -- --stage <stage>`
 *
 * Build a Linux AMD64 runner from this checkout and stage it for one commit.
 *
 * CI is the normal path. This is the local escape hatch for tight iteration on
 * the runner itself: Docker builds the same native library and Go binary on any
 * host, stamps the commit into the health route's version, packages the exact
 * object name `stack/runner-binary.ts` resolves in build mode, and uploads it —
 * then prints the deploy that installs it.
 *
 * Three properties are load-bearing and each is enforced rather than assumed:
 *
 *   the checkout is clean, submodules included. A commit-keyed object that
 *   contained uncommitted work would claim to hold bytes that commit does not
 *   produce, and nothing downstream could tell.
 *
 *   the destination is checked before the build, not after. Compiling libkrun
 *   takes minutes; discovering a missing bucket or an expired session at the
 *   end of it wastes all of them.
 *
 *   publication is write-once. Everything downstream treats version+commit as
 *   an identity — the engine's trigger, the health-route comparison, the
 *   "already serving it" skip — and none of them look at content. A second
 *   publication under one key would leave installed hosts on the old bytes
 *   forever while new hosts got the new ones, under one reported identity.
 *   `--if-none-match '*'` makes S3 refuse with a 412 instead, so changed bytes
 *   need a new commit.
 *
 * A fully published commit is the desired end state, so rerunning for the same
 * clean commit is a no-op rather than a 412 — rerunning is normal here. A
 * *partially* published one is reported rather than repaired: a rebuild is not
 * byte-identical (gzip alone stamps an mtime), so writing the missing manifest
 * would describe bytes that are not the ones stored, and every host would then
 * fail its digest check.
 *
 * Either cloud stages it, under one key: `runner/<commit>/<name>` in the
 * stage's own artifacts bucket, which is S3 on AWS and Cloud Storage on GCP.
 * `stack/runner-binary.ts` composes the same key for the deploy, so the object
 * this uploads is the object a host is told to fetch.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseInvocation, type Options } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveHome } from 'mstage/home'
import { run as mstage } from 'mstage/run'
import { resolveScope } from 'mstage/scope'
import { deployRoot } from './config.ts'
import { spawnWith, type RunCommand } from './upgrade-runners.ts'
import { gcpRunnerArtifactsBucket, readWorkspaceVersion, runnerArtifactsBucket } from '../stack/runner-binary.ts'

export class RunnerBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerBuildError'
  }
}

const USAGE = [
  'usage: npm run runner:build -- --stage <stage>',
  '',
  'Builds a runner from this checkout and stages it for its commit, so a deploy',
  'can install an unreleased change. The checkout must be clean.',
].join('\n')

const COMMIT = /^[0-9a-f]{40}$/

/** The Dockerfile that produces the tarball and its manifest, repository-relative. */
/**
 * Checkout-relative, and joined to the checkout root before docker sees it.
 *
 * Docker resolves a relative `--file` against its client's own directory, which
 * is neither the build context nor the root: `deployRoot` finds the committed file
 * by walking up, so this runs from `apps/infra` or below. Left relative here
 * because that is how the path reads in the tree and in the error below.
 */
const DOCKERFILE = 'apps/runner/packaging/dev-artifact.Dockerfile'

export type BuildInput = {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: (line: string) => void
  checkLogin?: typeof mstage
  resolveHomeWith?: typeof resolveHome
  /** Injected so a build is provable without Docker, an account or a bucket. */
  run?: RunCommand
  /** Injected for the same reason: nothing here should have to write to a disk to be tested. */
  makeWorkDirectory?: () => string
  removeWorkDirectory?: (path: string) => void
  fileExists?: (path: string) => boolean
}

/** A command whose failure is the answer, not an exception to swallow. */
const must = (run: RunCommand, file: string, args: string[], what: string): string => {
  const result = run(file, args)
  if (!result.ok) throw new RunnerBuildError(`${what} failed: ${result.stderr || result.stdout || '(no output)'}`)
  return result.stdout
}

/**
 * The checkout this build is of, asked once and used for everything anchored.
 *
 * Not `deployRoot`, which is the directory holding
 * `mstage.config.json` — `apps/infra` — while everything the Dockerfile copies
 * (`Cargo.toml`, `src/`, `sdks/`, `apps/go.work`) is above it. Asked from that
 * directory rather than from the process's cwd so a nested repository below
 * this one cannot answer instead.
 */
const checkoutRoot = ({ configuration, run }: { configuration: string; run: RunCommand }): string =>
  must(run, 'git', ['-C', configuration, 'rev-parse', '--show-toplevel'], 'locating the checkout root')

/**
 * The commit this artifact is keyed to, and the proof it describes that commit.
 *
 * Anchored to the checkout root rather than to the process's directory: run
 * from a nested repository a bare `rev-parse` answers for that one, and this
 * call decides which commit the object claims to hold.
 */
export const inspectCheckout = ({ root, run }: { root: string; run: RunCommand }): { ref: string; version: string } => {
  const ref = must(run, 'git', ['-C', root, 'rev-parse', 'HEAD'], 'reading the checkout’s commit')
  if (!COMMIT.test(ref)) throw new RunnerBuildError(`git returned an invalid commit ${JSON.stringify(ref)}`)

  const dirty = must(run, 'git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], 'reading the tree')
  if (dirty) {
    throw new RunnerBuildError(
      'the checkout has uncommitted changes; commit them before staging a commit-keyed runner artifact',
    )
  }
  const submodules = must(run, 'git', ['-C', root, 'submodule', 'status', '--recursive'], 'reading the submodules')
  const lines = submodules.split('\n').filter(Boolean)
  const named = (marked: string[]) => marked.map((line) => line.trim().split(/\s+/)[1]).join(', ')
  const missing = lines.filter((line) => line.startsWith('-'))
  if (missing.length > 0) throw new RunnerBuildError(`these submodules are not initialised: ${named(missing)}`)
  const mismatched = lines.filter((line) => line.startsWith('+') || line.startsWith('U'))
  if (mismatched.length > 0) {
    throw new RunnerBuildError(`these submodules do not match the commit: ${named(mismatched)}`)
  }
  return { ref, version: readWorkspaceVersion({ from: root }) }
}

/**
 * What a listing means, once each cloud has produced one.
 *
 * Shared because the rule is: all of it, none of it, or a refusal. A rebuild is
 * not byte-identical — gzip alone stamps an mtime — so completing a partial
 * publication would store a manifest describing bytes that are not the ones
 * beside it, and every host would then fail its digest check.
 */
const classifyStaged = ({
  staged,
  names,
  prefix,
}: {
  staged: Set<string>
  names: string[]
  prefix: string
}): 'complete' | 'absent' => {
  const present = names.filter((name) => staged.has(`${prefix}/${name}`))
  if (present.length === 0) return 'absent'
  if (present.length === names.length) return 'complete'
  throw new RunnerBuildError(
    `${prefix}/ is partially published (${present.join(', ')} present). A rebuild is not byte-identical, ` +
      `so completing it here would publish a checksum for different bytes. Delete the objects under ${prefix}/ and rerun.`,
  )
}

/** What is already there, so a rerun is free and a half-publication is refused. */
const publishedAlready = ({
  run,
  region,
  bucket,
  prefix,
  names,
}: {
  run: RunCommand
  region: string
  bucket: string
  prefix: string
  names: string[]
}): 'complete' | 'absent' => {
  const listed = must(
    run,
    'aws',
    // `head-bucket` below already needs s3:ListBucket, so this adds no permission.
    ['s3api', 'list-objects-v2', '--region', region, '--bucket', bucket, '--prefix', `${prefix}/`, '--query', 'Contents[].Key', '--output', 'text'],
    `listing what is staged under ${prefix}/`,
  )
  const staged = new Set(listed.split(/\s+/).filter((key) => key && key !== 'None'))
  return classifyStaged({ staged, names, prefix })
}

/**
 * The same question on Cloud Storage.
 *
 * `ls` over the prefix rather than a stat per object: one call, and a prefix
 * that holds nothing exits non-zero with `matched no objects`, which is the
 * answer rather than a failure.
 */
const gcpPublishedAlready = ({
  run,
  bucket,
  prefix,
  names,
}: {
  run: RunCommand
  bucket: string
  prefix: string
  names: string[]
}): 'complete' | 'absent' => {
  const listed = run('gcloud', ['storage', 'ls', `gs://${bucket}/${prefix}/`])
  if (!listed.ok) {
    if (/matched no objects|not found|404/i.test(`${listed.stderr}${listed.stdout}`)) return 'absent'
    throw new RunnerBuildError(`listing what is staged under ${prefix}/ failed: ${listed.stderr || listed.stdout}`)
  }
  const staged = new Set(
    listed.stdout
      .split(/\s+/)
      .filter(Boolean)
      .map((line) => line.replace(`gs://${bucket}/`, '')),
  )
  return classifyStaged({ staged, names, prefix })
}

/**
 * One cloud's staging bucket, as the three things this command does to it.
 *
 * A shape rather than a branch at each call site: the build in between is
 * identical, and the differences are exactly these three — how the bucket is
 * proved to exist, how it is listed, and what makes a write refuse to overwrite.
 */
type Destination = {
  /** How the prefix reads in a message and in the line printed at the end. */
  address: string
  /** Proved before the build, because compiling libkrun takes minutes. */
  assertReachable: () => void
  publishedAlready: () => 'complete' | 'absent'
  put: (name: string, file: string) => void
}

const awsDestination = ({
  run,
  app,
  stage,
  region,
  prefix,
  names,
}: {
  run: RunCommand
  app: string
  stage: string
  region: string
  prefix: string
  names: string[]
}): Destination => {
  const accountId = must(
    run,
    'aws',
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    'reading the AWS account id',
  )
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new RunnerBuildError(`could not read the AWS account id (got ${JSON.stringify(accountId)})`)
  }
  const bucket = runnerArtifactsBucket({ app, stage, accountId })
  return {
    address: `s3://${bucket}/${prefix}`,
    assertReachable: () => {
      must(run, 'aws', ['s3api', 'head-bucket', '--region', region, '--bucket', bucket], `finding the bucket ${bucket}`)
    },
    publishedAlready: () => publishedAlready({ run, region, bucket, prefix, names }),
    put: (name, file) => {
      must(
        run,
        'aws',
        [
          's3api',
          'put-object',
          '--region',
          region,
          '--bucket',
          bucket,
          '--key',
          `${prefix}/${name}`,
          '--body',
          file,
          // Write-once. See this file's own note: a second publication under one
          // identity is the failure nothing downstream could detect.
          '--if-none-match',
          '*',
        ],
        `uploading ${name}`,
      )
    },
  }
}

const gcpDestination = ({
  run,
  app,
  stage,
  project,
  prefix,
  names,
}: {
  run: RunCommand
  app: string
  stage: string
  project: string
  prefix: string
  names: string[]
}): Destination => {
  const bucket = gcpRunnerArtifactsBucket({ app, stage, project })
  return {
    address: `gs://${bucket}/${prefix}`,
    assertReachable: () => {
      must(run, 'gcloud', ['storage', 'buckets', 'describe', `gs://${bucket}`], `finding the bucket ${bucket}`)
    },
    publishedAlready: () => gcpPublishedAlready({ run, bucket, prefix, names }),
    put: (name, file) => {
      must(
        run,
        'gcloud',
        [
          'storage',
          'cp',
          file,
          `gs://${bucket}/${prefix}/${name}`,
          // Generation 0 is "this object does not exist", which is Cloud
          // Storage's spelling of S3's `--if-none-match '*'`: the same
          // write-once rule, refused by the service rather than by a check that
          // could straddle another upload.
          '--if-generation-match=0',
        ],
        `uploading ${name}`,
      )
    },
  }
}

/** The project a GCP stage declares. The bucket name carries it, so it is not optional. */
const projectOf = (scope: { project?: string | null }, stage: string): string => {
  const project = scope.project?.trim()
  if (!project) {
    throw new RunnerBuildError(`stage "${stage}" declares no project, and a Cloud Storage bucket is named after one`)
  }
  return project
}

export const buildRunner = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  checkLogin = mstage,
  resolveHomeWith = resolveHome,
  run: injectedRun,
  makeWorkDirectory = () => mkdtempSync(join(tmpdir(), 'boxlite-runner-artifact-')),
  removeWorkDirectory = (path: string) => rmSync(path, { recursive: true, force: true }),
  fileExists = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
}: BuildInput): Promise<number> => {
  if (argv[0] === 'help' || argv[0] === '--help') {
    log(USAGE)
    return 0
  }

  const { options, inner } = parseInvocation(['build', ...argv], environment, {})
  if (inner) throw new RunnerBuildError(`runner:build takes no inner command.\n${USAGE}`)

  const config = loadConfig({ cwd, environment })
  const scope = resolveScope({ options: options as Options, config, environment })
  const stage = scope.stage as string

  const signedIn = await checkLogin({ argv: ['login', '--stage', stage], environment, cwd, log })
  if (signedIn !== 0) throw new RunnerBuildError('Required sign-ins are missing; run `npm run mstage login -- -f` first')

  const home = await resolveHomeWith({ scope })
  const cloud = home.identity.home
  const { env: credentials } = await home.identity.childEnvironment()
  const run = injectedRun ?? spawnWith({ ...environment, ...credentials })

  const repository = checkoutRoot({ configuration: deployRoot({ cwd, environment }), run })
  const { ref, version } = inspectCheckout({ root: repository, run })
  const archive = `boxlite-runner-v${version}-${ref}-linux-amd64.tar.gz`
  const names = [archive, `${archive}.sha256`]
  const identity = `${version}+${ref}`

  /*
   * The destination, resolved and reachable, before anything is compiled.
   *
   * Each cloud's qualifier comes from where the deploy reads it: AWS's account
   * from the session mstage resolved, Google's project from the stage's own
   * declaration — the same values `sst.config.ts` and `pulumi/program.ts` name
   * the bucket from. A build that staged into one and a deploy that read
   * another would 404 on the host, at a boot that never happens again.
   */
  const prefix = `runner/${ref}`
  const destination =
    cloud === 'aws'
      ? awsDestination({ run, app: config.app, stage, region: scope.region as string, prefix, names })
      : gcpDestination({ run, app: config.app, stage, project: projectOf(scope, stage), prefix, names })
  destination.assertReachable()

  if (destination.publishedAlready() === 'complete') {
    log(`${destination.address}/ is already published; leaving it untouched`)
    log(`RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${ref} npm run mdeploy -- --stage ${stage}`)
    return 0
  }

  const work = makeWorkDirectory()
  try {
    log(`==> building ${identity} for linux/amd64`)
    must(
      run,
      'docker',
      [
        'build',
        '--platform',
        'linux/amd64',
        '--file',
        join(repository, DOCKERFILE),
        '--target',
        'artifact',
        '--build-arg',
        `BUILD_REF=${ref}`,
        '--build-arg',
        `VERSION=${version}`,
        '--build-arg',
        `VERSION_IDENTITY=${identity}`,
        '--output',
        `type=local,dest=${work}`,
        repository,
      ],
      'the runner artifact build',
    )
    for (const name of names) {
      if (!fileExists(join(work, name))) {
        throw new RunnerBuildError(`the build produced no ${name}; ${DOCKERFILE} and this command disagree`)
      }
    }

    for (const name of names) {
      log(`==> uploading ${name}`)
      destination.put(name, join(work, name))
    }
  } finally {
    removeWorkDirectory(work)
  }

  log(`staged ${archive} (${identity}) at ${destination.address}/`)
  /*
   * The runner's own keys, not the global pair.
   *
   * This staged a runner and nothing else, so the API keeps resolving the image
   * for the deployed commit. The global key would point it at a commit image
   * only CI publishes.
   */
  log(`RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${ref} npm run mdeploy -- --stage ${stage}`)
  return 0
}
