/*
 * Moving a staged runner between two stages.
 *
 * The property that matters is that nothing is rebuilt: the bytes one stage
 * serves are the bytes the next one gets, because version+commit is an identity
 * everything downstream compares and no one looks inside. So what is asserted
 * is what left the source and what arrived — and the two shapes that must be
 * refused rather than copied around: a source that holds nothing, and one that
 * holds half a publication.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promoteRunner } from '../src/runner-promote.ts'
import { RunnerBuildError } from '../src/runner-build.ts'
import { runnerArtifactsBucket } from '../stack/runner-binary.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'

const REF = 'b'.repeat(40)
const ACCOUNT = '123456789012'
const ARCHIVE = `boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz`
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const bucketFor = (stage: string) => runnerArtifactsBucket({ app: 'boxlite-app', stage, accountId: ACCOUNT })

/** Two stages' buckets, each holding whatever the case says it holds. */
const cloud = (held: Record<string, string[]>, calls: string[][] = []): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    const asked = args.join(' ')
    if (asked.includes('get-caller-identity')) return ok(ACCOUNT)
    if (asked.includes('head-bucket')) return ok('')
    if (asked.includes('list-objects-v2')) {
      const stage = Object.keys(held).find((name) => asked.includes(bucketFor(name)))
      const names = stage ? held[stage] ?? [] : []
      return ok(names.map((name) => `runner/${REF}/${name}`).join('\t') || 'None')
    }
    return ok('')
  }
}

const drive = (run: RunCommand, argv: string[], log: string[] = []) =>
  promoteRunner({
    argv,
    environment: { MSTAGE_CONFIG: EXAMPLE },
    cwd: new URL('../..', import.meta.url).pathname,
    log: (line) => log.push(line),
    checkLogin: async () => 0,
    resolveHomeWith: (async () => ({
      identity: { home: 'aws', childEnvironment: async () => ({ env: {}, expiresAt: null }) },
      backend: {},
    })) as never,
    run,
  })

test('it copies exactly what the source holds, and names nothing itself', async () => {
  // The archive carries the version it was built from, so the source bucket is
  // the only thing that knows what this commit produced — a promotion that
  // composed the name would promote whatever the working copy happens to be.
  const calls: string[][] = []
  const log: string[] = []
  const run = cloud({ dev: [ARCHIVE, `${ARCHIVE}.sha256`], prod: [] }, calls)
  assert.equal(await drive(run, ['--tag', REF, '--from', 'dev', '--to', 'prod'], log), 0)

  const copies = calls.filter((call) => call[1] === 's3' && call[2] === 'cp').map((call) => call.slice(-2))
  assert.deepEqual(copies, [
    [`s3://${bucketFor('dev')}/runner/${REF}/${ARCHIVE}`, `s3://${bucketFor('prod')}/runner/${REF}/${ARCHIVE}`],
    [
      `s3://${bucketFor('dev')}/runner/${REF}/${ARCHIVE}.sha256`,
      `s3://${bucketFor('prod')}/runner/${REF}/${ARCHIVE}.sha256`,
    ],
  ])
  assert.ok(log.some((line) => line.includes('RUNNER_ARTIFACT_REF=' + REF)), 'it must print the deploy that installs it')
})

test('a destination that already holds it is left untouched', async () => {
  // Rerunning is how a caller asks "is it there?", so it has to be free.
  const calls: string[][] = []
  const held = [ARCHIVE, `${ARCHIVE}.sha256`]
  assert.equal(await drive(cloud({ dev: held, prod: held }, calls), ['--tag', REF, '--from', 'dev', '--to', 'prod']), 0)
  assert.equal(calls.filter((call) => call[2] === 'cp').length, 0, 'nothing may be copied over what is there')
})

test('a source that holds nothing is refused, not treated as a no-op', async () => {
  // The caller asked for this commit. Saying "done" would deploy a stage that
  // installs a binary it does not have.
  await assert.rejects(
    async () => drive(cloud({ dev: [], prod: [] }), ['--tag', REF, '--from', 'dev', '--to', 'prod']),
    /holds nothing; dev has no runner staged/,
  )
})

test('half a publication is refused rather than half promoted', async () => {
  // The manifest without its tarball, or the other way round: copying either
  // leaves a destination whose checksum describes bytes that are not there.
  await assert.rejects(
    async () => drive(cloud({ dev: [ARCHIVE], prod: [] }), ['--tag', REF, '--from', 'dev', '--to', 'prod']),
    /which is not a tarball and its manifest/,
  )
})

test('a stage on another cloud is refused, because one session writes both', async () => {
  // `dev2` is the example's GCP stage; this session is on AWS.
  await assert.rejects(
    async () => drive(cloud({ dev: [ARCHIVE, `${ARCHIVE}.sha256`] }), ['--tag', REF, '--from', 'dev', '--to', 'dev2']),
    /cannot promote between clouds/,
  )
})

test('it addresses bytes, and refuses a name that is not one', async () => {
  await assert.rejects(
    async () => drive(cloud({}), ['--tag', 'v0.10.0', '--from', 'dev', '--to', 'prod']),
    RunnerBuildError,
  )
  await assert.rejects(
    async () => drive(cloud({}), ['--tag', REF, '--from', 'dev', '--to', 'dev']),
    /promoting "dev" to itself/,
  )
})
