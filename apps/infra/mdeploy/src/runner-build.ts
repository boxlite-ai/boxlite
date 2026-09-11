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
 * AWS only, because the staging bucket is S3. A GCP stage installs a published
 * release; `stack/runner-binary.ts` refuses build mode there rather than
 * composing an address that would fail on a host.
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
import { readWorkspaceVersion, runnerArtifactsBucket } from '../stack/runner-binary.ts'

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
  const present = names.filter((name) => staged.has(`${prefix}/${name}`))
  if (present.length === 0) return 'absent'
  if (present.length === names.length) return 'complete'
  throw new RunnerBuildError(
    `${prefix}/ is partially published (${present.join(', ')} present). A rebuild is not byte-identical, ` +
      `so completing it here would publish a checksum for different bytes. Delete the objects under ${prefix}/ and rerun.`,
  )
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
  if (home.identity.home !== 'aws') {
    throw new RunnerBuildError(
      `stage "${stage}" lives in ${home.identity.home}, which stages no runner artifact: the bucket is S3. ` +
        'A GCP stage installs a published release',
    )
  }
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
   * The account id comes from the session mstage resolved rather than from a
   * setting: the bucket name carries it, and a build that uploaded into one
   * account while the deploy read another would 404 on the host.
   */
  const accountId = must(
    run,
    'aws',
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    'reading the AWS account id',
  )
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new RunnerBuildError(`could not read the AWS account id (got ${JSON.stringify(accountId)})`)
  }
  const region = scope.region as string
  const bucket = runnerArtifactsBucket({ app: config.app, stage, accountId })
  const prefix = `runner/${ref}`
  must(run, 'aws', ['s3api', 'head-bucket', '--region', region, '--bucket', bucket], `finding the bucket ${bucket}`)

  if (publishedAlready({ run, region, bucket, prefix, names }) === 'complete') {
    log(`s3://${bucket}/${prefix}/ is already published; leaving it untouched`)
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
          join(work, name),
          // Write-once. See this file's own note: a second publication under one
          // identity is the failure nothing downstream could detect.
          '--if-none-match',
          '*',
        ],
        `uploading ${name}`,
      )
    }
  } finally {
    removeWorkDirectory(work)
  }

  log(`staged ${archive} (${identity}) at s3://${bucket}/${prefix}/`)
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
