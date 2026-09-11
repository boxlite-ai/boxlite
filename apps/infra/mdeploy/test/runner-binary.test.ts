/*
 * Which binary a deploy installs, and what it refuses to guess.
 *
 * The version is the checkout's, so most of what is worth pinning here is the
 * refusals: a resolver that answered *something* for a malformed selector would
 * compose an address nothing published, and the failure would land on a host's
 * first boot — where the boot script never runs again.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RunnerBinaryError,
  artifactFetchCommand,
  readWorkspaceVersion,
  resolveRunnerBinary,
  runnerArtifactFor,
  selectRunnerBinary,
  verifyAgainstManifest,
} from '../stack/runner-binary.ts'

const REF = 'b'.repeat(40)
const BUCKET = 'boxlite-app-dev-artifacts-123456789012'

const readVersion = () => '0.10.0'
const resolve = (environment: NodeJS.ProcessEnv, artifactsBucket: string | null = null) =>
  resolveRunnerBinary({ environment, configRoot: '/repo/apps/infra', artifactsBucket, readVersion })

test('the version is the checkout’s, and VERSION names a different published release', () => {
  // The incumbent path's own rule: the workspace version is what every published
  // asset is published under, and VERSION selects a different one. Nothing about
  // it is a stage's setting — a store value would pin a fleet to whatever was
  // current the day someone seeded it.
  assert.deepEqual(selectRunnerBinary({ environment: {}, workspaceVersion: '0.10.0' }), {
    kind: 'release',
    version: '0.10.0',
  })
  assert.deepEqual(selectRunnerBinary({ environment: { VERSION: '0.9.5' }, workspaceVersion: '0.10.0' }), {
    kind: 'release',
    version: '0.9.5',
  })
  assert.deepEqual(selectRunnerBinary({ environment: { VERSION: 'v0.9.5' }, workspaceVersion: '0.10.0' }), {
    kind: 'release',
    version: '0.9.5',
  })
})

test('RUNNER_VERSION is not read, because a stage does not choose the commit’s version', () => {
  // It was a store key for exactly one commit's worth of history. On the
  // incumbent path it is the out-of-band override `runner/update.ts` reads when
  // a person rolls the fleet by hand, and a deploy has never read it.
  const resolved = resolve({ RUNNER_VERSION: '0.1.0' })
  assert.equal(resolved.version, '0.10.0', 'the checkout answered, not the environment')
})

test('a version that is not a stable release names which side was wrong', () => {
  // The distinction matters to whoever has to fix it: an operator edits VERSION,
  // a release engineer edits Cargo.toml.
  assert.throws(
    () => selectRunnerBinary({ environment: { VERSION: '0.10.0-rc.1' }, workspaceVersion: '0.10.0' }),
    /VERSION must be a stable semantic version/,
  )
  assert.throws(
    () => selectRunnerBinary({ environment: {}, workspaceVersion: '0.10.0-alpha' }),
    /the workspace version "0.10.0-alpha" is not a stable semantic version/,
  )
})

test('the workspace version is read from the Cargo.toml above the config', () => {
  // Found by walking up from where `mdeploy.config.json` was, not from where
  // this package happens to be installed.
  const root = mkdtempSync(join(tmpdir(), 'mdeploy-workspace-'))
  writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\nedition = "2021"\n')
  assert.equal(readWorkspaceVersion({ from: root }), '1.2.3')
  assert.equal(readWorkspaceVersion({ from: join(root, 'apps', 'infra') }), '1.2.3', 'walks up')
})

test('a checkout with no workspace version says so, and says what to set instead', () => {
  const root = mkdtempSync(join(tmpdir(), 'mdeploy-bare-'))
  assert.throws(
    () => readWorkspaceVersion({ from: join(root, 'apps', 'infra') }),
    /could not find a workspace Cargo\.toml above .*Set VERSION to name a published release explicitly/s,
  )
})

test('a release resolves to the assets the publisher actually uploads', () => {
  // The names are the release workflow's, not this module's choice: a deploy
  // that composed a different one would resolve an address nothing published.
  const { tarballName, tarballUrl, checksumUrl, transport } = runnerArtifactFor({
    selector: { kind: 'release', version: '0.10.0' },
  })
  assert.equal(tarballName, 'boxlite-runner-v0.10.0-linux-amd64.tar.gz')
  assert.equal(tarballUrl, `https://github.com/boxlite-ai/boxlite/releases/download/v0.10.0/${tarballName}`)
  assert.equal(checksumUrl, `${tarballUrl}.sha256`)
  assert.equal(transport, 'https')
})

test('a build is addressed by the commit it was produced from, under the staging prefix', () => {
  const artifact = runnerArtifactFor({
    selector: { kind: 'build', version: '0.10.0', ref: REF },
    artifactsBucket: BUCKET,
  })
  assert.equal(artifact.tarballName, `boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz`)
  assert.equal(artifact.tarballUrl, `s3://${BUCKET}/runner/${REF}/${artifact.tarballName}`)
  assert.equal(artifact.checksumUrl, `${artifact.tarballUrl}.sha256`)
  assert.equal(artifact.transport, 's3')
})

test('release is what an unconfigured deploy installs, and a build is opt-in', () => {
  // A rule derived from the stage would silently change which binary a plain
  // deploy puts onto a state-holding host.
  assert.equal(resolve({}).source, 'release')
  assert.throws(() => resolve({ RUNNER_ARTIFACT_SOURCE: 'staging' }), /must be "release" or "build"/)
})

test('a build with no commit, or an abbreviated one, is refused rather than composed', () => {
  // An abbreviation addresses a different object even when it names the same
  // commit, so it is refused rather than expanded.
  assert.throws(() => resolve({ BOXLITE_ARTIFACT_SOURCE: 'build' }, BUCKET), /set BOXLITE_ARTIFACT_REF to a full git commit sha/)
  assert.throws(
    () => resolve({ RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: REF.slice(0, 7) }, BUCKET),
    /set RUNNER_ARTIFACT_REF to a full git commit sha/,
  )
  // The component key wins over the global, and the failure names whichever one
  // was actually set — an operator edits the variable they touched.
  assert.throws(
    () => resolve({ BOXLITE_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: 'nope' }, BUCKET),
    /set RUNNER_ARTIFACT_REF to/,
  )
})

test('a build on a cloud with no staging bucket is refused before a host is created', () => {
  // A GCP stage installs a published release: there is no S3 to stage into, and
  // composing an s3:// address anyway would fail on the host at first boot,
  // permanently, because the boot script never runs again.
  assert.throws(
    () => resolve({ RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: REF }, null),
    /staged in a bucket, and this stage has none/,
  )
  assert.throws(
    () => resolve({ RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: REF }, 'Not_A_Bucket'),
    /is not a valid S3 bucket name/,
  )
})

test('a build reports the commit as build metadata, or two builds are indistinguishable', () => {
  // Without it the upgrade's "already serving the target" guard would skip every
  // dev deploy after the first, which is what makes a dev host untestable.
  const built = resolve({ RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: REF }, BUCKET)
  assert.equal(built.identity, `0.10.0+${REF}`)
  assert.equal(built.version, '0.10.0')
  assert.equal(built.source, 'build')
  assert.equal(resolve({}).identity, '0.10.0', 'a release is its own identity')
})

test('the fetch is bounded, and an s3 address needs the region it lives in', () => {
  // A transport that can hang forever may continue after the deploy supervising
  // it already failed, and swap a binary nobody is watching for.
  const published = artifactFetchCommand({
    artifact: { transport: 'https' },
    url: 'https://example.invalid/r.tar.gz',
    destination: '/tmp/r',
  })
  assert.match(published, /--max-time 300/)
  assert.match(published, /--proto '=https' --proto-redir '=https'/, 'no downgrade to plain http on a redirect')

  const staged = { artifact: { transport: 's3' as const }, url: 's3://b/k', destination: '/tmp/r' }
  assert.match(artifactFetchCommand({ ...staged, region: 'ap-southeast-1' }), /s3 cp --region ap-southeast-1/)
  assert.throws(() => artifactFetchCommand(staged), /needs the region that bucket lives in/)
  assert.throws(() => artifactFetchCommand({ ...staged, region: 'ap southeast 1' }), /needs the region/)
})

test('the manifest is verified before the bytes are trusted', () => {
  /*
   * Ordering only. What the fragment *does* — refusing a manifest that names
   * another file, an uppercase digest, a wrong length, a mismatch — is proved
   * by running it, in `runner-payload.test.ts`.
   *
   * Deliberately not asserted here: the escaped awk pattern. A test that
   * spelled it out would be this file writing the pattern and then finding it,
   * and it would keep passing with the escaping removed — which is exactly the
   * defect that matters, since unescaped dots are wildcards.
   */
  const script = verifyAgainstManifest({
    tarballName: 'boxlite-runner-v0.10.0-linux-amd64.tar.gz',
    tarball: '$WORK/runner.tar.gz',
    manifest: '$WORK/runner.sha256',
  })
  const reads = script.indexOf('EXPECTED=$(awk')
  const hashes = script.indexOf('sha256sum')
  const compares = script.indexOf('[ "$EXPECTED" = "$ACTUAL" ]')
  assert.ok(reads !== -1 && reads < hashes && hashes < compares, 'read the manifest, hash the bytes, then compare')
})

test('RunnerBinaryError is the single failure type callers can catch', () => {
  assert.throws(() => resolve({ VERSION: 'latest' }), (error) => error instanceof RunnerBinaryError)
})
