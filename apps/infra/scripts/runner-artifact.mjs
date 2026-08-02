// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The Runner's install artifact — from either source, in the one shape both install paths take.
 *
 * The EC2 user-data (sst.config.ts buildRunnerUserData) and the SSM upgrade payload
 * (runner-update-binary.mjs) do the same three things: fetch a tarball, fetch its .sha256
 * sidecar, refuse to install unless the manifest names exactly that tarball. They differ only in
 * where the two URLs point — which is why a second source needs no new install logic on the
 * host, just a different pair of URLs and the command that fetches them.
 *
 *   release → the published GitHub Release assets: public HTTPS, fetched with curl
 *   build   → objects staged in the stack's artifacts bucket, read with the Runner's instance
 *             role (`aws s3 cp`), so nothing built from an unreleased commit is ever published
 *
 * Both halves of a build-mode URL are validated here rather than trusted: the string is
 * interpolated verbatim into a bash payload that runs as root on the Runner.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { resolveAwsRegion } from './deployment-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'
import { resolveRunnerReleaseAssets, verifyRunnerReleaseAssets } from './runner-release-assets.mjs'

const BUILD_ARTIFACT_BUCKET_KEY = 'RUNNER_ARTIFACT_BUCKET'
// The S3 naming rules that matter here: lowercase, no underscores, 3-63 characters. Anything
// outside them is either not a bucket or an attempt to break out of the s3:// URL.
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const COMMIT_REF = /^[0-9a-f]{40}$/
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const execFileAsync = promisify(execFile)

// The artifacts bucket is named rather than generated so CI can stage a build into it before the
// deploy that installs it — no stack output to read first. Derived in one place because two
// callers need the same answer: the stack that creates it, and the preflight that reads it.
export function runnerArtifactsBucketName({ app, stage, accountId }) {
  const bucket = `${app}-${stage}-artifacts-${accountId}`
  if (!BUCKET_NAME.test(bucket)) {
    throw new Error(`artifact stage '${stage}' does not produce a valid S3 bucket name`)
  }
  return bucket
}

function requireBuildLocation(source, environment) {
  const ref = source.ref
  if (!ref || !COMMIT_REF.test(ref)) {
    throw new Error(
      `a build-mode Runner artifact needs the commit it was produced from ` +
        `(set BOXLITE_ARTIFACT_REF to a git commit sha), got '${ref ?? ''}'`,
    )
  }
  if (!STABLE_VERSION.test(source.version ?? '')) {
    throw new Error(
      `a build-mode Runner artifact needs its checkout's stable X.Y.Z version (got '${source.version ?? ''}')`,
    )
  }
  const bucket = environment[BUILD_ARTIFACT_BUCKET_KEY]?.trim()
  if (!bucket) {
    throw new Error(`${BUILD_ARTIFACT_BUCKET_KEY} is required to locate a build-mode Runner artifact`)
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new Error(`${BUILD_ARTIFACT_BUCKET_KEY} '${bucket}' is not a valid S3 bucket name`)
  }

  const tarballName = `boxlite-runner-v${source.version}-${ref}-linux-amd64.tar.gz`
  return { bucket, tarballName, key: `runner/${ref}/${tarballName}` }
}

// The `fetch` discriminant is annotated rather than inferred: sst.config.ts consumes this from
// TypeScript, where a bare 'https' in a returned object literal widens to `string` and no longer
// satisfies the 'https' | 's3' the install helpers switch on.
/**
 * @returns {{
 *   tarballName: string
 *   checksumName: string
 *   tarballUrl: string
 *   checksumUrl: string
 *   fetch: 'https' | 's3'
 * }}
 */
export function resolveRunnerArtifact(source, environment = process.env) {
  if (source.kind !== 'release' && source.kind !== 'build') {
    throw new Error(`unknown Runner artifact source '${source.kind}'`)
  }
  if (source.kind === 'release') {
    // Delegates unchanged, so the stable-semver gate still rejects a prerelease target on the
    // path where version ordering is load-bearing.
    return { ...resolveRunnerReleaseAssets(source.version), fetch: 'https' }
  }

  const { bucket, tarballName, key } = requireBuildLocation(source, environment)
  return {
    tarballName,
    checksumName: `${tarballName}.sha256`,
    tarballUrl: `s3://${bucket}/${key}`,
    checksumUrl: `s3://${bucket}/${key}.sha256`,
    fetch: 's3',
  }
}

// The one command that fetches an artifact, shared by both install paths so "how do we get this
// URL" is answered once. Emitted into bash that runs as root, so the region is validated for the
// same reason the bucket and ref are.
const AWS_REGION_NAME = /^[a-z0-9-]+$/
export function artifactFetchCommand(artifact, url, destination, region) {
  // Keep the remote command inside the deployer's SSM supervision window (ssmSupervisionSeconds
  // in runner-update-binary.mjs, which PAYLOAD_WORST_CASE_SECONDS counts these bounds toward). A
  // transport that can hang forever may continue later and swap a binary after the deploy
  // already failed.
  if (artifact.fetch === 'https') {
    return (
      `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' ` +
      `--connect-timeout 10 --max-time 300 --retry 5 --retry-delay 2 --retry-connrefused ` +
      `--retry-max-time 300 "${url}" -o "${destination}"`
    )
  }
  if (artifact.fetch !== 's3') throw new Error(`unknown Runner artifact fetch '${artifact.fetch}'`)
  if (!AWS_REGION_NAME.test(region ?? '')) {
    throw new Error(`an S3 artifact fetch needs an AWS region, got '${region ?? ''}'`)
  }
  return `aws --cli-connect-timeout 10 --cli-read-timeout 300 s3 cp --region ${region} ` + `"${url}" "${destination}"`
}

async function runAwsCli(awsCliPath, args, description, { environment, timeoutMs, signal }) {
  try {
    const { stdout } = await execFileAsync(awsCliPath, args, {
      encoding: 'utf8',
      env: environment,
      killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      // The deployer aborts this on SIGINT/SIGTERM. Without it a Ctrl-C during the preflight
      // would be ignored until the in-flight request returns or hits its own timeout.
      ...(signal ? { signal } : {}),
    })
    return stdout
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`Runner artifact ${description} request failed: ${detail}`, { cause: error })
  }
}

// One budget for the whole preflight, as on the release path: two calls each granted the full
// timeout would quietly double the worst case a caller thought it had asked for.
function remainingTimeoutMs(deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Runner artifact preflight exceeded its timeout')
  return remaining
}

export async function resolveAwsAccountId({ awsCliPath, environment = process.env, timeoutMs = 15_000, signal } = {}) {
  const cli = awsCliPath ?? resolveAwsCliPath(environment)
  const accountId = (
    await runAwsCli(cli, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], 'account id', {
      environment,
      timeoutMs,
      signal,
    })
  ).trim()
  if (!/^[0-9]{12}$/.test(accountId)) throw new Error(`could not read the AWS account id (got '${accountId}')`)
  return accountId
}

async function verifyBuildArtifact(source, { awsCliPath, environment, timeoutMs, signal }) {
  const { bucket, tarballName, key } = requireBuildLocation(source, environment)
  const region = resolveAwsRegion(environment)
  const cli = awsCliPath ?? resolveAwsCliPath(environment)
  const deadline = Date.now() + timeoutMs

  // Same contract the release preflight enforces, and the same one the host re-checks against
  // the bytes it actually downloaded: one lowercase digest naming exactly this tarball.
  const manifest = (
    await runAwsCli(cli, ['s3', 'cp', '--region', region, `s3://${bucket}/${key}.sha256`, '-'], 'checksum', {
      environment,
      timeoutMs: remainingTimeoutMs(deadline),
      signal,
    })
  ).trim()
  // Lowercase only, matching the host's `[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]]`. With /i an
  // uppercase digest passes here and then fails the bootstrap — the opposite of what a preflight
  // is for, which is to refuse on the deployer rather than on the instance.
  const checksum = manifest.match(/^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)$/)
  if (!checksum) {
    throw new Error(
      `Runner artifact checksum manifest must be one '<lowercase sha256>  ${tarballName}' line, ` +
        'in the form the host re-checks it against',
    )
  }
  if (checksum[2] !== tarballName) {
    throw new Error(`Runner artifact checksum manifest must name exactly '${tarballName}'`)
  }

  await runAwsCli(cli, ['s3api', 'head-object', '--region', region, '--bucket', bucket, '--key', key], 'tarball', {
    environment,
    timeoutMs: remainingTimeoutMs(deadline),
    signal,
  })
  return resolveRunnerArtifact(source, environment)
}

export async function verifyRunnerArtifact(source, { environment = process.env, timeoutMs = 15_000, ...cli } = {}) {
  if (source.kind !== 'release' && source.kind !== 'build') {
    throw new Error(`unknown Runner artifact source '${source.kind}'`)
  }
  if (source.kind === 'release') {
    return { ...(await verifyRunnerReleaseAssets(source.version, { ...cli, environment, timeoutMs })), fetch: 'https' }
  }
  return verifyBuildArtifact(source, { ...cli, environment, timeoutMs })
}
