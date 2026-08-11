// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Build and stage a Linux AMD64 Runner from the current checkout.
 *
 * CI is the normal path. This is the local escape hatch for tight iteration: Docker builds the
 * same native library + Go binary shape on any host, stamps the commit into the health-route
 * version, packages the exact S3 key the deploy resolver expects, and uploads it before printing
 * the matching deploy command.
 *
 * Usage:
 *   npm run runner:build-artifact -- --stage dev --region ap-southeast-1
 *   npm run runner:build-artifact -- --stage dev --region ap-southeast-1 --release <sha256>
 *
 * The checkout must be clean and its submodules initialized. Otherwise a commit-keyed object
 * would claim to contain bytes that the named commit does not actually produce.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DeploymentConfigStore } from './deployment-config-store.mjs'
import { readWorkspaceVersion, resolveAwsRegion } from './deployment-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'
import { runnerArtifactsBucketName } from './runner-artifact.mjs'

const APP = 'boxlite'
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const COMMIT = /^[0-9a-f]{40}$/
const STAGE = /^[a-z0-9]{1,20}$/
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/
const RELEASE = /^[0-9a-f]{64}$/

function checked(
  command,
  args,
  { cwd, environment = process.env, description = `${command} ${args[0]}`, stdio = 'pipe' } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`${description} could not start: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`${description} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return (result.stdout || '').trim()
}

export function parseRunnerArtifactArgs(argv) {
  const options = {}
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index].match(/^--(stage|region|release)$/)?.[1]
    if (!name) throw new Error(`unknown argument '${argv[index]}' (expected --stage, --region, or --release)`)
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`--${name} requires a value`)
    if (options[name] !== undefined) throw new Error(`--${name} may be specified only once`)
    options[name] = value
    index += 1
  }
  if (!options.stage) throw new Error('--stage is required')
  if (!options.region) throw new Error('--region is required')
  if (!STAGE.test(options.stage)) throw new Error(`invalid stage '${options.stage}'`)
  if (!REGION.test(options.region)) throw new Error(`invalid region '${options.region}'`)
  if (options.release && !RELEASE.test(options.release)) throw new Error('invalid release; expected a lowercase SHA-256')
  return { stage: options.stage, region: options.region, releaseId: options.release }
}

export class RunnerArtifactBuilder {
  constructor({
    environment = process.env,
    run = checked,
    accountId,
    readVersion = readWorkspaceVersion,
    awsCliPath = resolveAwsCliPath,
    configStore = (options) => new DeploymentConfigStore(options),
  } = {}) {
    this.environment = environment
    this.run = run
    this.accountId = accountId
    this.readVersion = readVersion
    this.awsCliPath = awsCliPath
    this.configStore = configStore
  }

  inspectCheckout() {
    // Anchored to this module rather than the process working directory: from a nested
    // repository or submodule a bare rev-parse answers for that one, and this call decides
    // which commit the artifact is keyed to.
    const repositoryRoot = this.run('git', ['rev-parse', '--show-toplevel'], { cwd: SCRIPT_DIRECTORY })
    const ref = this.run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
    if (!COMMIT.test(ref)) throw new Error(`git returned an invalid commit '${ref}'`)

    const dirty = this.run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repositoryRoot })
    if (dirty) {
      throw new Error(
        'the checkout has uncommitted changes; commit them before creating a commit-keyed Runner artifact',
      )
    }
    const submodules = this.run('git', ['submodule', 'status', '--recursive'], { cwd: repositoryRoot })
    const submoduleLines = submodules.split('\n').filter(Boolean)
    const missing = submoduleLines.filter((line) => line.startsWith('-')).map((line) => line.trim().split(/\s+/)[1])
    if (missing.length > 0) {
      throw new Error(`Runner build submodules are not initialized: ${missing.join(', ')}`)
    }
    const mismatched = submoduleLines
      .filter((line) => line.startsWith('+') || line.startsWith('U'))
      .map((line) => line.trim().split(/\s+/)[1])
    if (mismatched.length > 0) {
      throw new Error(`Runner build submodules do not match the commit: ${mismatched.join(', ')}`)
    }

    return { repositoryRoot, ref, version: this.readVersion({ moduleDirectory: repositoryRoot }) }
  }

  async build({ repositoryRoot, ref, version }) {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'boxlite-runner-artifact-'))
    const identity = `${version}+${ref}`
    try {
      this.run(
        'docker',
        [
          'build',
          '--platform',
          'linux/amd64',
          '--file',
          'apps/runner/packaging/dev-artifact.Dockerfile',
          '--target',
          'artifact',
          '--build-arg',
          `BUILD_REF=${ref}`,
          '--build-arg',
          `VERSION=${version}`,
          '--build-arg',
          `VERSION_IDENTITY=${identity}`,
          '--output',
          `type=local,dest=${outputDirectory}`,
          '.',
        ],
        { cwd: repositoryRoot, description: 'Linux AMD64 Runner artifact build', stdio: 'inherit' },
      )
      const archive = `boxlite-runner-v${version}-${ref}-linux-amd64.tar.gz`
      await stat(join(outputDirectory, archive))
      await stat(join(outputDirectory, `${archive}.sha256`))
      return { outputDirectory, archive, identity }
    } catch (error) {
      await rm(outputDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async prepareStage({ stage, ref, region, releaseId }) {
    const awsCliPath = this.awsCliPath(this.environment)
    const selectedRegion = region ?? resolveAwsRegion(this.environment)
    let accountId
    let selectedReleaseId = releaseId
    if (this.accountId) {
      // An injected resolver keeps the builder unit-testable without an AWS CLI.
      accountId = await this.accountId({ awsCliPath, environment: this.environment })
    } else {
      const release = this.configStore({ awsCliPath, region: selectedRegion }).resolve({ stage, releaseId })
      accountId = release.document.accountId
      selectedReleaseId = release.releaseId
    }
    const bucket = runnerArtifactsBucketName({ app: APP, stage, accountId })
    const keyPrefix = `runner/${ref}`
    const prefix = `s3://${bucket}/${keyPrefix}`

    // Discover missing credentials/bootstrap before spending minutes compiling libkrun.
    this.run(awsCliPath, ['s3api', 'head-bucket', '--region', selectedRegion, '--bucket', bucket], {
      environment: this.environment,
      description: `artifact bucket ${bucket} lookup`,
    })
    return { awsCliPath, region: selectedRegion, releaseId: selectedReleaseId, bucket, keyPrefix, prefix }
  }

  // Write-once, because everything downstream treats version+ref as an identity: the Pulumi
  // trigger, the health-route comparison, and the "already at target" skip all ignore content. A
  // second publication under the same key would leave installed hosts on the old bytes forever
  // while new hosts got the new ones, under one reported identity. `--if-none-match '*'` makes
  // S3 refuse instead (412), so a changed build must take a new commit.
  //
  // A ref that is *fully* published is the desired end state, so a repeat run for the same clean
  // commit is a no-op rather than a 412 — this script exists for tight iteration, where rerunning
  // is normal. A *partially* published ref is not repaired here: the rebuild is not byte-identical
  // (gzip alone stamps an mtime), so writing the missing manifest would describe bytes that are
  // not the ones stored, and every host would then fail the digest check. That needs a human to
  // delete the partial key, so it is reported rather than patched over.
  stage({ outputDirectory, archive, awsCliPath, region, bucket, keyPrefix }) {
    const names = [archive, `${archive}.sha256`]
    const staged = this.run(
      awsCliPath,
      // head-bucket above already needs s3:ListBucket, so this adds no permission.
      // prettier-ignore
      ['s3api', 'list-objects-v2', '--region', region, '--bucket', bucket,
       '--prefix', `${keyPrefix}/`, '--query', 'Contents[].Key', '--output', 'text'],
      { environment: this.environment, description: `list staged objects under ${keyPrefix}/` },
    )
    const alreadyStaged = new Set(staged.split(/\s+/).filter((key) => key && key !== 'None'))
    const present = names.filter((name) => alreadyStaged.has(`${keyPrefix}/${name}`))

    if (present.length === names.length) {
      console.log(`  ${keyPrefix}/ is already published; leaving it untouched`)
      return
    }
    if (present.length > 0) {
      throw new Error(
        `${keyPrefix}/ is partially published (${present.join(', ')} present). A rebuild is not ` +
          'byte-identical, so completing it here would publish a checksum for different bytes. ' +
          `Delete the objects under ${keyPrefix}/ and rerun.`,
      )
    }

    for (const name of names) {
      this.run(
        awsCliPath,
        [
          's3api',
          'put-object',
          '--region',
          region,
          '--bucket',
          bucket,
          '--key',
          `${keyPrefix}/${name}`,
          '--body',
          join(outputDirectory, name),
          '--if-none-match',
          '*',
        ],
        {
          environment: this.environment,
          description: `upload ${name}`,
          stdio: 'inherit',
        },
      )
    }
  }

  async execute({ stage, region, releaseId }) {
    const checkout = this.inspectCheckout()
    const destination = await this.prepareStage({ stage, ref: checkout.ref, region, releaseId })
    const built = await this.build(checkout)
    try {
      this.stage({ ...built, ...destination })
      return { ...checkout, ...built, ...destination, stage }
    } finally {
      await rm(built.outputDirectory, { recursive: true, force: true })
    }
  }
}

async function main() {
  const options = parseRunnerArtifactArgs(process.argv)
  const result = await new RunnerArtifactBuilder().execute(options)
  console.log(`staged ${result.archive} (${result.identity}) at ${result.prefix}`)
  // Runner-scoped, not the global pair: this staged a Runner and nothing else, so the Api keeps
  // building from the checkout. The global key would point it at a commit image only CI publishes.
  console.log(
    `RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${result.ref} ` +
      `BOXLITE_DEPLOY_CONFIG_RELEASE=${result.releaseId} AWS_REGION=${result.region} ` +
      `npm run deploy -- --stage ${result.stage}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`runner-artifact-build: ${error.message}`)
    process.exit(1)
  }
}
