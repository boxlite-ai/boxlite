// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  artifactFetchCommand,
  resolveRunnerArtifact,
  runnerArtifactsBucketName,
  verifyRunnerArtifact,
} from './runner-artifact.mjs'

const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const BUCKET = 'boxlite-dev-artifacts'
const BUILD_TARBALL = `boxlite-runner-v1.2.3-${REF}-linux-amd64.tar.gz`
const BUILD_KEY = `runner/${REF}/${BUILD_TARBALL}`
const VERSION = '1.2.3'
const RELEASE_TARBALL = `boxlite-runner-v${VERSION}-linux-amd64.tar.gz`
const DIGEST = 'a'.repeat(64)

const buildSource = { kind: 'build', ref: REF, version: VERSION }
const releaseSource = { kind: 'release', version: VERSION }
const buildEnvironment = { ...process.env, RUNNER_ARTIFACT_BUCKET: BUCKET, AWS_REGION: 'ap-southeast-1' }

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function createFakeExecutable(t, name, body) {
  const directory = mkdtempSync(join(tmpdir(), `boxlite-runner-artifact-${name}-`))
  const path = join(directory, name)
  const logPath = join(directory, `${name}.log`)
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${shellQuote(logPath)}
${body}
`,
  )
  chmodSync(path, 0o755)
  return { path, logPath }
}

const createFakeAws = (t, { manifest = `${DIGEST}  ${BUILD_TARBALL}\n`, checksumExit = 0, headExit = 0 } = {}) =>
  createFakeExecutable(
    t,
    'aws',
    `case "$*" in
  *.sha256*)
    [[ ${checksumExit} -eq 0 ]] || exit ${checksumExit}
    printf '%s' ${shellQuote(manifest)}
    ;;
  *head-object*) exit ${headExit} ;;
  *) exit 2 ;;
esac`,
  )

const createFakeCurl = (t) =>
  createFakeExecutable(
    t,
    'curl',
    `case "$*" in
  *${RELEASE_TARBALL}.sha256*) printf '%s' ${shellQuote(`${DIGEST}  ${RELEASE_TARBALL}\n`)} ;;
  *${RELEASE_TARBALL}*) exit 0 ;;
  *) exit 2 ;;
esac`,
  )

test('the bootstrap, deploy preflight, and local stager derive one bucket name', () => {
  assert.equal(
    runnerArtifactsBucketName({ app: 'boxlite', stage: 'dev', accountId: '123456789012' }),
    'boxlite-dev-artifacts-123456789012',
  )
  assert.throws(
    () => runnerArtifactsBucketName({ app: 'boxlite', stage: 'Feature_One', accountId: '123456789012' }),
    /does not produce a valid S3 bucket name/,
  )
})

test('the fetch command is selected by the artifact, never by the host caller', () => {
  const https = artifactFetchCommand(
    { fetch: 'https' },
    'https://example.test/runner.tar.gz',
    '/tmp/runner.tar.gz',
    'ignored',
  )
  // Bounded and retried: the deployer supervises this fetch over SSM and cannot cancel it, so an
  // unbounded transfer could still swap the binary after the deploy already reported failure.
  assert.ok(https.startsWith('curl --fail --silent --show-error --location'))
  assert.match(https, /--connect-timeout 10 --max-time 300/)
  assert.match(https, /--retry 5 --retry-delay 2 --retry-connrefused --retry-max-time 300/)
  assert.ok(https.endsWith('"https://example.test/runner.tar.gz" -o "/tmp/runner.tar.gz"'))
  assert.equal(
    artifactFetchCommand({ fetch: 's3' }, 's3://bucket/runner.tar.gz', '/tmp/runner.tar.gz', 'ap-southeast-1'),
    'aws --cli-connect-timeout 10 --cli-read-timeout 300 s3 cp --region ap-southeast-1 "s3://bucket/runner.tar.gz" "/tmp/runner.tar.gz"',
  )
  assert.throws(
    () => artifactFetchCommand({ fetch: 's3' }, 's3://bucket/object', '/tmp/object', 'region; id'),
    /needs an AWS region/,
  )
  assert.throws(
    () => artifactFetchCommand({ fetch: 'ftp' }, 'ftp://example.test/object', '/tmp/object', 'ignored'),
    /unknown Runner artifact fetch/,
  )
  assert.throws(() => resolveRunnerArtifact({ kind: 'nightly' }, buildEnvironment), /unknown Runner artifact source/)
})

test('a release artifact keeps the published URLs and is fetched over https', () => {
  const releaseUrl = `https://github.com/boxlite-ai/boxlite/releases/download/v${VERSION}/${RELEASE_TARBALL}`
  assert.deepEqual(resolveRunnerArtifact(releaseSource, buildEnvironment), {
    tarballName: RELEASE_TARBALL,
    checksumName: `${RELEASE_TARBALL}.sha256`,
    tarballUrl: releaseUrl,
    checksumUrl: `${releaseUrl}.sha256`,
    fetch: 'https',
  })
})

test('release mode still refuses a target with no publishable release', () => {
  assert.throws(
    () => resolveRunnerArtifact({ kind: 'release', version: '1.2.3-rc.1' }, buildEnvironment),
    /not a stable semantic version/,
  )
})

test('a build artifact is addressed in the stack bucket by the commit that produced it', () => {
  assert.deepEqual(resolveRunnerArtifact(buildSource, buildEnvironment), {
    tarballName: BUILD_TARBALL,
    checksumName: `${BUILD_TARBALL}.sha256`,
    tarballUrl: `s3://${BUCKET}/${BUILD_KEY}`,
    checksumUrl: `s3://${BUCKET}/${BUILD_KEY}.sha256`,
    fetch: 's3',
  })
})

test('a build artifact refuses anything that would not name one immutable object', () => {
  // Both halves land verbatim in a bash payload that runs as root on the Runner.
  assert.throws(
    () => resolveRunnerArtifact({ kind: 'build' }, buildEnvironment),
    /needs the commit it was produced from/,
  )
  assert.throws(
    () => resolveRunnerArtifact({ kind: 'build', ref: 'main' }, buildEnvironment),
    /needs the commit it was produced from/,
  )
  assert.throws(
    () => resolveRunnerArtifact({ kind: 'build', ref: REF }, buildEnvironment),
    /needs its checkout's stable X.Y.Z version/,
  )
  assert.throws(() => resolveRunnerArtifact(buildSource, { ...process.env, RUNNER_ARTIFACT_BUCKET: '' }), /is required/)
  assert.throws(
    () => resolveRunnerArtifact(buildSource, { ...process.env, RUNNER_ARTIFACT_BUCKET: 'bad bucket; rm -rf /' }),
    /is not a valid S3 bucket name/,
  )
})

test('verifying a build artifact checks the manifest names it, then that the tarball exists', async (t) => {
  const aws = createFakeAws(t)
  const assets = await verifyRunnerArtifact(buildSource, {
    awsCliPath: aws.path,
    environment: buildEnvironment,
    timeoutMs: 5_000,
  })

  assert.equal(assets.tarballName, BUILD_TARBALL)
  assert.equal(assets.fetch, 's3')
  const requests = readFileSync(aws.logPath, 'utf8').trim().split('\n')
  assert.deepEqual(requests, [
    `s3 cp --region ap-southeast-1 s3://${BUCKET}/${BUILD_KEY}.sha256 -`,
    `s3api head-object --region ap-southeast-1 --bucket ${BUCKET} --key ${BUILD_KEY}`,
  ])
})

test('verifying a build artifact fails closed on a manifest for a different tarball', async (t) => {
  const wrongName = createFakeAws(t, { manifest: `${DIGEST}  boxlite-runner-someone-elses.tar.gz\n` })
  await assert.rejects(
    verifyRunnerArtifact(buildSource, { awsCliPath: wrongName.path, environment: buildEnvironment, timeoutMs: 15_000 }),
    /checksum manifest must name exactly/,
  )

  const noManifest = createFakeAws(t, { checksumExit: 1 })
  await assert.rejects(
    verifyRunnerArtifact(buildSource, {
      awsCliPath: noManifest.path,
      environment: buildEnvironment,
      timeoutMs: 15_000,
    }),
    /checksum request failed/,
  )

  const noTarball = createFakeAws(t, { headExit: 254 })
  await assert.rejects(
    verifyRunnerArtifact(buildSource, { awsCliPath: noTarball.path, environment: buildEnvironment, timeoutMs: 15_000 }),
    /tarball request failed/,
  )
})

// The deployer aborts this controller on SIGINT/SIGTERM. Ctrl-C must not wait out an AWS call
// that is allowed to run for the whole preflight budget, so the timeout below is the assertion:
// an unplumbed signal leaves the request running and fails the test rather than passing slowly.
test('aborting the deployer cancels an in-flight build artifact request', { timeout: 10_000 }, async (t) => {
  const stalledAws = createFakeExecutable(t, 'aws', 'sleep 30')
  const preflight = new AbortController()

  const verification = verifyRunnerArtifact(buildSource, {
    awsCliPath: stalledAws.path,
    environment: buildEnvironment,
    timeoutMs: 30_000,
    signal: preflight.signal,
  })
  preflight.abort(new Error('Artifact preflight interrupted by SIGINT'))

  await assert.rejects(verification, /checksum request failed/)
})

test('a manifest the host would reject is refused on the deployer', async (t) => {
  // The host applies `^[0-9a-f]{64}$`. Accepting uppercase here just moves the failure onto the
  // instance, which is the thing the preflight exists to prevent.
  const upperCase = createFakeAws(t, { manifest: `${DIGEST.toUpperCase()}  ${BUILD_TARBALL}\n` })

  await assert.rejects(
    verifyRunnerArtifact(buildSource, { awsCliPath: upperCase.path, environment: buildEnvironment, timeoutMs: 15_000 }),
    // Not "names a different tarball" — it names the right one; the digest is the wrong shape.
    /must be one '<lowercase sha256>/,
  )
})

test('verifying a release artifact still runs the published-asset preflight', async (t) => {
  const curl = createFakeCurl(t)
  const assets = await verifyRunnerArtifact(releaseSource, {
    curlPath: curl.path,
    environment: buildEnvironment,
    timeoutMs: 5_000,
  })

  assert.equal(assets.tarballName, RELEASE_TARBALL)
  assert.equal(assets.fetch, 'https')
  assert.equal(readFileSync(curl.logPath, 'utf8').trim().split('\n').length, 2)
})
