/*
 * Staging a runner for one commit.
 *
 * What is worth pinning are the three properties the incumbent script earned the
 * hard way: the commit an object claims has to be the commit it holds, the
 * destination is checked before minutes of compilation, and a key is written
 * once. The last one is the subtle one — everything downstream treats
 * version+commit as an identity and looks at no content, so a second
 * publication under one key is a fleet split across two sets of bytes under one
 * reported version.
 */

import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RunnerBuildError, buildRunner, inspectCheckout } from '../src/runner-build.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'

const REF = 'a'.repeat(40)

/**
 * The committed example, not this machine's stage file.
 *
 * These drive the real `--stage` resolution, so the stages they name have to be
 * declared somewhere — and `.mstage.config.json` is not committed, so on a
 * runner there is nothing to declare them. Reading the example also keeps it
 * from going stale: a stage dropped from it fails here.
 */
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))
/**
 * What `rev-parse --show-toplevel` answers, and this checkout really — because
 * `inspectCheckout` reads the workspace Cargo.toml off disk, so a made-up root
 * would fail on that rather than on what is being asserted.
 */
const CHECKOUT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '')
const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const failed = (stderr: string): CommandResult => ({ ok: false, status: 1, stdout: '', stderr })

/** A clean checkout, an existing empty bucket, and a build that produces both files. */
const happy = (calls: string[][] = [], overrides: Record<string, CommandResult> = {}): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    const asked = args.join(' ')
    for (const [needle, answer] of Object.entries(overrides)) if (asked.includes(needle)) return answer
    if (file === 'git' && asked.includes('rev-parse --show-toplevel')) return ok(CHECKOUT)
    if (file === 'git' && asked.includes('rev-parse HEAD')) return ok(REF)
    if (file === 'git' && asked.includes('status --porcelain')) return ok('')
    if (file === 'git' && asked.includes('submodule status')) return ok(' abc123 src/vendor (v1)')
    if (asked.includes('get-caller-identity')) return ok('123456789012')
    if (asked.includes('head-bucket')) return ok('')
    if (asked.includes('list-objects-v2')) return ok('None')
    return ok('')
  }
}

const drive = (run: RunCommand, argv = ['--stage', 'dev'], log: string[] = []) =>
  buildRunner({
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
    makeWorkDirectory: () => '/tmp/work',
    removeWorkDirectory: () => {},
    fileExists: () => true,
  })

test('the destination is proved reachable before anything is compiled', async () => {
  // Compiling libkrun takes minutes; discovering a missing bucket or an expired
  // session at the end of them wastes all of them.
  const calls: string[][] = []
  assert.equal(await drive(happy(calls)), 0)
  const order = calls.map((call) => call.join(' '))
  const bucket = order.findIndex((line) => line.includes('head-bucket'))
  const built = order.findIndex((line) => line.startsWith('docker build'))
  assert.ok(bucket !== -1 && built !== -1)
  assert.ok(bucket < built, 'the bucket was looked up after the build')
})

test('the object is named for the commit and the workspace version, and both are stamped in', async () => {
  // The name is what `stack/runner-binary.ts` resolves in build mode, and the
  // identity is what a host reports on its health route — an upgrade that could
  // not tell two builds of one checkout apart would skip every dev deploy after
  // the first.
  const calls: string[][] = []
  await drive(happy(calls))
  const build = calls.find((call) => call[1] === 'build')?.join(' ') as string
  assert.match(build, /--build-arg BUILD_REF=a{40}/)
  assert.match(build, /--build-arg VERSION=\d+\.\d+\.\d+/)
  assert.match(build, new RegExp(`--build-arg VERSION_IDENTITY=\\d+\\.\\d+\\.\\d+\\+${REF}`))

  const uploads = calls.filter((call) => call.includes('put-object'))
  assert.equal(uploads.length, 2, 'the tarball and its manifest')
  for (const upload of uploads) {
    assert.match(upload.join(' '), new RegExp(`--key runner/${REF}/boxlite-runner-v\\d+\\.\\d+\\.\\d+-${REF}-linux-amd64\\.tar\\.gz`))
  }
})

test('the Dockerfile is addressed from the checkout root, not from wherever this ran', async () => {
  /*
   * Docker resolves a relative `--file` against its client's own directory,
   * which is not the build context and not the repository root: this tool finds
   * its config by walking up, so it runs from `apps/infra` or below and never
   * from the root. A relative path there fails with `unable to prepare context:
   * unable to evaluate symlinks in Dockerfile path`, which reads as a broken
   * checkout rather than as a wrong cwd — and `RunCommand` has no `cwd` to pass,
   * deliberately, because every other call here is already anchored with
   * `git -C` or an absolute name.
   */
  const calls: string[][] = []
  await drive(happy(calls))
  const build = calls.find((call) => call[1] === 'build') as string[]
  const file = build[build.indexOf('--file') + 1] as string
  assert.ok(isAbsolute(file), `docker was handed a relative Dockerfile: ${file}`)
  assert.equal(file, `${CHECKOUT}/apps/runner/packaging/dev-artifact.Dockerfile`)
  // The context is that same root, or the two disagree about which checkout is
  // being built — and the Dockerfile copies Cargo.toml, src/ and sdks/, none of
  // which exist under the directory `mstage.config.json` lives in.
  assert.equal(build[build.length - 1], CHECKOUT)
})

test('a key is written once, so changed bytes need a new commit', async () => {
  // Everything downstream treats version+commit as an identity and looks at no
  // content. A second publication would leave installed hosts on the old bytes
  // while new hosts got the new ones, under one reported version.
  const calls: string[][] = []
  await drive(happy(calls))
  for (const upload of calls.filter((call) => call.includes('put-object'))) {
    const flag = upload.indexOf('--if-none-match')
    assert.notEqual(flag, -1, 'S3 was allowed to overwrite an existing identity')
    assert.equal(upload[flag + 1], '*')
  }
})

test('a commit already published is a no-op, because rerunning is normal here', async () => {
  const archive = /boxlite-runner-v\d+\.\d+\.\d+-a{40}-linux-amd64\.tar\.gz/
  const log: string[] = []
  const calls: string[][] = []
  const listed = (file: string, args: string[]): CommandResult => {
    const asked = args.join(' ')
    if (asked.includes('list-objects-v2')) {
      // Both objects, as the API would name them.
      return ok(`runner/${REF}/boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz runner/${REF}/boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz.sha256`)
    }
    return happy(calls)(file, args)
  }
  assert.equal(await drive(listed, ['--stage', 'dev'], log), 0)
  assert.ok(!calls.some((call) => call[1] === 'build'), 'it rebuilt an artifact that was already there')
  assert.ok(log.some((line) => line.includes('already published')))
  assert.ok(log.some((line) => archive.test(line) || line.includes('RUNNER_ARTIFACT_REF')))
})

test('a half-published commit is reported rather than completed', async () => {
  // A rebuild is not byte-identical — gzip alone stamps an mtime — so writing
  // the missing manifest would describe bytes that are not the ones stored, and
  // every host would then fail its digest check.
  const partial = (file: string, args: string[]): CommandResult =>
    args.join(' ').includes('list-objects-v2')
      ? ok(`runner/${REF}/boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz`)
      : happy()(file, args)
  await assert.rejects(
    () => drive(partial),
    (error: Error) => {
      assert.ok(error instanceof RunnerBuildError)
      assert.match(error.message, /partially published/)
      assert.match(error.message, /Delete the objects under runner\/a{40}\/ and rerun/)
      return true
    },
  )
})

test('an unclean checkout is refused, submodules included', () => {
  // A commit-keyed object holding uncommitted work would claim bytes that commit
  // does not produce, and nothing downstream could tell.
  const run = (answers: Record<string, CommandResult>): RunCommand => happy([], answers)
  assert.throws(
    () => inspectCheckout({ root: '/repo', run: run({ 'status --porcelain': ok(' M src/main.rs') }) }),
    /uncommitted changes/,
  )
  assert.throws(
    () => inspectCheckout({ root: '/repo', run: run({ 'submodule status': ok('-abc123 src/vendor') }) }),
    /these submodules are not initialised: src\/vendor/,
  )
  assert.throws(
    () => inspectCheckout({ root: '/repo', run: run({ 'submodule status': ok('+abc123 src/vendor') }) }),
    /these submodules do not match the commit: src\/vendor/,
  )
  assert.throws(
    () => inspectCheckout({ root: '/repo', run: run({ 'rev-parse HEAD': ok('abc') }) }),
    /git returned an invalid commit "abc"/,
  )
})

test('a GCP stage is refused, because the staging bucket is S3', async () => {
  // Not a limitation to work around: a GCP stage installs a published release,
  // and `stack/runner-binary.ts` refuses build mode there for the same reason.
  await assert.rejects(
    () =>
      buildRunner({
        argv: ['--stage', 'dev2'],
        environment: { MSTAGE_CONFIG: EXAMPLE },
        cwd: new URL('../..', import.meta.url).pathname,
        log: () => {},
        checkLogin: async () => 0,
        resolveHomeWith: (async () => ({
          identity: { home: 'gcp', childEnvironment: async () => ({ env: {}, expiresAt: null }) },
          backend: {},
        })) as never,
        run: happy(),
      }),
    /lives in gcp, which stages no runner artifact/,
  )
})

test('a build that produced nothing is named, rather than uploading an absent file', async () => {
  await assert.rejects(
    () =>
      buildRunner({
        argv: ['--stage', 'dev'],
        environment: { MSTAGE_CONFIG: EXAMPLE },
        cwd: new URL('../..', import.meta.url).pathname,
        log: () => {},
        checkLogin: async () => 0,
        resolveHomeWith: (async () => ({
          identity: { home: 'aws', childEnvironment: async () => ({ env: {}, expiresAt: null }) },
          backend: {},
        })) as never,
        run: happy(),
        makeWorkDirectory: () => '/tmp/work',
        removeWorkDirectory: () => {},
        fileExists: () => false,
      }),
    /the build produced no boxlite-runner-v.*and this command disagree/,
  )
})

test('a failing command stops the run with what it said', async () => {
  const denied = (file: string, args: string[]): CommandResult =>
    args.join(' ').includes('head-bucket') ? failed('An error occurred (403) when calling HeadBucket') : happy()(file, args)
  await assert.rejects(() => drive(denied), /finding the bucket boxlite-app-dev-artifacts-123456789012 failed: .*403/)
})
