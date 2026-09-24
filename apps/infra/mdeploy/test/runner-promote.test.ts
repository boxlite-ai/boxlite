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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promoteRunner } from '../src/runner-promote.ts'
import { RunnerBuildError } from '../src/runner-build.ts'
import { gcpRunnerArtifactsBucket, runnerArtifactsBucket } from '../stack/runner-binary.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'

const REF = 'b'.repeat(40)
const ACCOUNT = '123456789012'
const ARCHIVE = `boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz`
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const failed = (stderr: string): CommandResult => ({ ok: false, status: 1, stdout: '', stderr })
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

test('a name every object inherits is not a stage to promote to', async () => {
  /*
   * Both stage names reach maps parsed out of the stage file, which inherit
   * `toString`; a lookup through the chain takes that function for a
   * declaration and reads `.home` off it rather than refusing the name.
   *
   * The two arrive at different guards, so both are asked. Only `--to` is
   * scope-resolved; `--from` reaches `destinationFor` with nothing in front
   * of it, which is why that guard is not redundant with this one.
   */
  await assert.rejects(
    async () => drive(cloud({ dev: [ARCHIVE, `${ARCHIVE}.sha256`] }), ['--tag', REF, '--from', 'toString', '--to', 'prod']),
    /no stage "toString" is declared/,
    'the source stage was taken from the prototype chain',
  )
  await assert.rejects(
    async () => drive(cloud({ dev: [ARCHIVE, `${ARCHIVE}.sha256`] }), ['--tag', REF, '--from', 'dev', '--to', 'toString']),
    /Stage "toString" \(from --stage\) is not declared/,
    'the destination stage was taken from the prototype chain',
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

/*
 * The same move on Google, where two stages are two projects.
 *
 * One session does the whole promotion — the destination's, because that is the
 * one that has to write — so every call against the source bucket is made by an
 * account from another project. What reaches across is a single grant on that
 * one bucket, `roles/storage.objectViewer`, and it carries object reads and
 * nothing else: no object role includes `storage.buckets.get`. So a promotion
 * that asks the source for its metadata is refused however correct the copy
 * would have been, and the account the refusal names is the destination's,
 * which reads as the wrong bucket rather than as the wrong call.
 */
const PROJECTS: Record<string, string> = { dev2: 'your-gcp-project-id', prod2: 'another-gcp-project-id' }
const gcpBucketFor = (stage: string) => gcpRunnerArtifactsBucket({ app: 'boxlite-app', stage, project: PROJECTS[stage]! })

/**
 * Two GCP stages, because the committed example declares one and a promotion
 * needs both ends. Cloned from that example rather than written out here, so
 * the fixture keeps whatever shape `loadConfig` currently accepts.
 */
const twoGoogleStages = (): { path: string; remove: () => void } => {
  const declared = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
  const second = structuredClone(declared.stages.dev2)
  second.project = PROJECTS.prod2
  second.registry.repository = 'boxlite-app-prod2'
  declared.stages.prod2 = second
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-promote-stages-'))
  const path = join(directory, '.mstage.config.json')
  writeFileSync(path, JSON.stringify(declared))
  return { path, remove: () => rmSync(directory, { recursive: true, force: true }) }
}

/** What Cloud Storage answers an account holding `objectViewer` on the source and its own project's admin. */
const googleCloud = (held: Record<string, string[]>, calls: string[][] = []): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    const asked = args.join(' ')
    if (asked.startsWith('storage buckets describe')) {
      if (!asked.includes(gcpBucketFor('dev2'))) return ok('')
      return failed(
        `ERROR: (gcloud.storage.buckets.describe) [bl-app-prod2-deploy@${PROJECTS.prod2}.iam.gserviceaccount.com] does ` +
          `not have permission to access b instance [${gcpBucketFor('dev2')}] (or it may not exist): ` +
          "Permission 'storage.buckets.get' denied on resource",
      )
    }
    if (asked.startsWith('storage ls')) {
      const stage = Object.keys(held).find((name) => asked.includes(gcpBucketFor(name)))
      const names = stage ? held[stage] ?? [] : []
      if (names.length === 0) return failed('matched no objects')
      return ok(names.map((name) => `gs://${gcpBucketFor(stage!)}/runner/${REF}/${name}`).join('\n'))
    }
    return ok('')
  }
}

test('a cross-project source is read at object level, never asked for its metadata', async () => {
  const stages = twoGoogleStages()
  const calls: string[][] = []
  try {
    const code = await promoteRunner({
      argv: ['--tag', REF, '--from', 'dev2', '--to', 'prod2'],
      environment: { MSTAGE_CONFIG: stages.path },
      cwd: new URL('../..', import.meta.url).pathname,
      log: () => {},
      checkLogin: async () => 0,
      resolveHomeWith: (async () => ({
        identity: { home: 'gcp', childEnvironment: async () => ({ env: {}, expiresAt: null }) },
        backend: {},
      })) as never,
      run: googleCloud({ dev2: [ARCHIVE, `${ARCHIVE}.sha256`], prod2: [] }, calls),
    })
    assert.equal(code, 0)
  } finally {
    stages.remove()
  }

  const described = calls.filter(([file, ...rest]) => file === 'gcloud' && rest.join(' ').startsWith('storage buckets describe'))
  assert.deepEqual(
    described.map((call) => call.at(-1)),
    [`gs://${gcpBucketFor('prod2')}`],
    'only the bucket this session writes may be asked for its metadata',
  )
  const copies = calls.filter(([file, , verb]) => file === 'gcloud' && verb === 'cp').map((call) => call.slice(3, 5))
  assert.deepEqual(copies, [
    [`gs://${gcpBucketFor('dev2')}/runner/${REF}/${ARCHIVE}`, `gs://${gcpBucketFor('prod2')}/runner/${REF}/${ARCHIVE}`],
    [
      `gs://${gcpBucketFor('dev2')}/runner/${REF}/${ARCHIVE}.sha256`,
      `gs://${gcpBucketFor('prod2')}/runner/${REF}/${ARCHIVE}.sha256`,
    ],
  ])
})
