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
 *   npm run runner:build-artifact
 *   npm run runner:build-artifact -- --stage dev
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

import { loadDeploymentEnvironment, readWorkspaceVersion, resolveAwsRegion } from '../deployment/environment.js'
import { resolveAwsCliPath } from '../shared/aws-cli.js'
import { resolveAwsAccountId, runnerArtifactsBucketName } from './runner.js'

const APP = 'boxlite'
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const COMMIT = /^[0-9a-f]{40}$/
const STAGE = /^[a-z0-9][a-z0-9-]{0,31}$/

function checked(
  command: string,
  args: string[],
  { cwd, environment = process.env, description = `${command} ${args[0]}`, stdio = 'pipe' }: any = {},
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

function parseArgs(argv: any) {
  let stage = process.env.SST_STAGE || 'dev'
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] !== '--stage') throw new Error(`unknown argument '${argv[index]}' (expected --stage <name>)`)
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error('--stage requires a value')
    stage = value
    index += 1
  }
  if (!STAGE.test(stage)) throw new Error(`invalid stage '${stage}'`)
  return { stage }
}

export class RunnerArtifactBuilder {
  environment: NodeJS.ProcessEnv
  run: any
  accountId: any
  readVersion: any
  awsCliPath: any
  loadEnvironment: any

  constructor({
    environment = process.env,
    run = checked,
    accountId = resolveAwsAccountId,
    readVersion = readWorkspaceVersion,
    awsCliPath = resolveAwsCliPath,
    loadEnvironment = loadDeploymentEnvironment,
  }: any = {}) {
    this.environment = environment
    this.run = run
    this.accountId = accountId
    this.readVersion = readVersion
    this.awsCliPath = awsCliPath
    this.loadEnvironment = loadEnvironment
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
    const missing = submoduleLines.filter((line: any) => line.startsWith('-')).map((line: any) => line.trim().split(/\s+/)[1])
    if (missing.length > 0) {
      throw new Error(`Runner build submodules are not initialized: ${missing.join(', ')}`)
    }
    const mismatched = submoduleLines
      .filter((line: any) => line.startsWith('+') || line.startsWith('U'))
      .map((line: any) => line.trim().split(/\s+/)[1])
    if (mismatched.length > 0) {
      throw new Error(`Runner build submodules do not match the commit: ${mismatched.join(', ')}`)
    }

    return { repositoryRoot, ref, version: this.readVersion({ moduleDirectory: repositoryRoot }) }
  }

  async build({ repositoryRoot, ref, version }: any) {
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

  async prepareStage({ stage, ref }: any) {
    const awsCliPath = this.awsCliPath(this.environment)
    const accountId = await this.accountId({ awsCliPath, environment: this.environment })
    const region = resolveAwsRegion(this.environment)
    const bucket = runnerArtifactsBucketName({ app: APP, stage, accountId })
    const keyPrefix = `runner/${ref}`
    const prefix = `s3://${bucket}/${keyPrefix}`

    // Discover missing credentials/bootstrap before spending minutes compiling libkrun.
    this.run(awsCliPath, ['s3api', 'head-bucket', '--bucket', bucket], {
      environment: this.environment,
      description: `artifact bucket ${bucket} lookup`,
    })
    return { awsCliPath, region, bucket, keyPrefix, prefix }
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
  stage({ outputDirectory, archive, awsCliPath, region, bucket, keyPrefix }: any) {
    const names = [archive, `${archive}.sha256`]
    const staged = this.run(
      awsCliPath,
      // head-bucket above already needs s3:ListBucket, so this adds no permission.
      // prettier-ignore
      ['s3api', 'list-objects-v2', '--region', region, '--bucket', bucket,
       '--prefix', `${keyPrefix}/`, '--query', 'Contents[].Key', '--output', 'text'],
      { environment: this.environment, description: `list staged objects under ${keyPrefix}/` },
    )
    const alreadyStaged = new Set(staged.split(/\s+/).filter((key: any) => key && key !== 'None'))
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

  async execute({ stage }: any) {
    // The printed deploy command runs through sst-with-cloudflare.mjs, which loads apps/infra/.env
    // before resolving AWS. Staging without it would take AWS_PROFILE/AWS_REGION/AWS_CLI_PATH from
    // the bare shell and could upload into a different account than the deploy then reads.
    this.loadEnvironment({ environment: this.environment })
    const checkout = this.inspectCheckout()
    const destination = await this.prepareStage({ stage, ref: checkout.ref })
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
  const options = parseArgs(process.argv)
  const result = await new RunnerArtifactBuilder().execute(options)
  console.log(`staged ${result.archive} (${result.identity}) at ${result.prefix}`)
  // Runner-scoped, not the global pair: this staged a Runner and nothing else, so the Api keeps
  // building from the checkout. The global key would point it at a commit image only CI publishes.
  console.log(
    `RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${result.ref} ` + `npm run deploy -- --stage ${result.stage}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error: any) {
    console.error(`runner-artifact-build: ${error.message}`)
    process.exit(1)
  }
}
