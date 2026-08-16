// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { RunnerArtifactBuilder } from './runner-build.js'

const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const VERSION = '1.2.3'
const ACCOUNT = '123456789012'
const ARCHIVE = `boxlite-runner-v${VERSION}-${REF}-linux-amd64.tar.gz`

function fakeBuilder({ dirty = '', submodules = ' e12b9b3 src/deps/libkrun-sys/vendor/libkrun', staged = '' } = {}) {
  const calls: any[] = []
  const run = (command: any, args: any, options = {}) => {
    calls.push({ command, args, options })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return REF
    if (command === 'git' && args[0] === 'status') return dirty
    if (command === 'git' && args[0] === 'submodule') return submodules
    if (command === 'docker') {
      const output = args[args.indexOf('--output') + 1]
      const directory = output.replace('type=local,dest=', '')
      writeFileSync(join(directory, ARCHIVE), 'tarball')
      writeFileSync(join(directory, `${ARCHIVE}.sha256`), `${'a'.repeat(64)}  ${ARCHIVE}\n`)
      return ''
    }
    if (command === '/fake/aws') return args[1] === 'list-objects-v2' ? staged : ''
    assert.fail(`unexpected command: ${command} ${args.join(' ')}`)
  }

  return {
    calls,
    builder: new RunnerArtifactBuilder({
      environment: { AWS_REGION: 'ap-southeast-1' },
      run,
      readVersion: () => VERSION,
      awsCliPath: () => '/fake/aws',
      accountId: async () => ACCOUNT,
      loadEnvironment: () => {
        calls.push({ command: 'loadDeploymentEnvironment', args: [] })
      },
    }),
  }
}

test('builds Linux AMD64 with the commit in both the version and archive identity', async () => {
  const { builder, calls } = fakeBuilder()
  const result = await builder.execute({ stage: 'dev' })

  assert.equal(result.identity, `${VERSION}+${REF}`)
  assert.equal(result.archive, ARCHIVE)
  assert.equal(result.bucket, `boxlite-app-dev-artifacts-${ACCOUNT}`)
  assert.equal(result.prefix, `s3://boxlite-app-dev-artifacts-${ACCOUNT}/runner/${REF}`)
  assert.equal(existsSync(result.outputDirectory), false, 'the temporary build output is removed after staging')

  const docker = calls.find((call) => call.command === 'docker')
  const bucketLookup = calls.findIndex((call) => call.command === '/fake/aws' && call.args[0] === 's3api')
  const dockerBuild = calls.findIndex((call) => call.command === 'docker')
  assert.ok(bucketLookup < dockerBuild, 'credentials and bucket bootstrap are checked before the expensive build')
  assert.ok(docker)
  assert.deepEqual(docker.args.slice(0, 5), [
    'build',
    '--platform',
    'linux/amd64',
    '--file',
    'apps/runner/packaging/dev-artifact.Dockerfile',
  ])
  assert.ok(docker.args.includes(`BUILD_REF=${REF}`))
  assert.ok(docker.args.includes(`VERSION=${VERSION}`))
  assert.ok(docker.args.includes(`VERSION_IDENTITY=${VERSION}+${REF}`))

  // Write-once, because the deploy identity is version+ref with no content digest.
  const uploads = calls.filter((call) => call.command === '/fake/aws' && call.args[1] === 'put-object')
  assert.equal(uploads.length, 2)
  for (const upload of uploads) {
    assert.equal(upload.args[upload.args.indexOf('--if-none-match') + 1], '*')
  }
  assert.deepEqual(
    uploads.map((call) => call.args[call.args.indexOf('--key') + 1]),
    [`runner/${REF}/${ARCHIVE}`, `runner/${REF}/${ARCHIVE}.sha256`],
  )
})

test('stages against the same AWS identity the printed deploy command will use', async () => {
  // The deploy goes through deployment/sst.ts, which loads apps/infra/.env. Resolving AWS
  // from the bare shell instead could upload into one account and then read from another.
  const { builder, calls } = fakeBuilder()
  await builder.execute({ stage: 'dev' })

  const loaded = calls.findIndex((call) => call.command === 'loadDeploymentEnvironment')
  const firstAws = calls.findIndex((call) => call.command === '/fake/aws')
  assert.notEqual(loaded, -1, 'the deployment environment is never loaded')
  assert.ok(loaded < firstAws, 'the environment must load before any AWS call resolves an account')
})

test('refuses a dirty checkout instead of publishing bytes under the wrong commit', () => {
  const { builder, calls } = fakeBuilder({ dirty: ' M apps/runner/cmd/runner/main.go' })
  assert.throws(() => builder.inspectCheckout(), /uncommitted changes/)
  assert.equal(
    calls.some((call) => call.command === 'docker'),
    false,
  )
})

test('refuses an uninitialized build dependency before starting Docker', () => {
  const { builder, calls } = fakeBuilder({
    submodules: '-e12b9b3 src/deps/libkrun-sys/vendor/libkrun\n da631e1 src/deps/e2fsprogs-sys/vendor/e2fsprogs',
  })
  assert.throws(
    () => builder.inspectCheckout(),
    /submodules are not initialized: src\/deps\/libkrun-sys\/vendor\/libkrun/,
  )
  assert.equal(
    calls.some((call) => call.command === 'docker'),
    false,
  )
})

test('refuses a submodule checked out at a different commit', () => {
  const { builder, calls } = fakeBuilder({
    submodules: '+e12b9b3 src/deps/libkrun-sys/vendor/libkrun\n da631e1 src/deps/e2fsprogs-sys/vendor/e2fsprogs',
  })
  assert.throws(() => builder.inspectCheckout(), /submodules do not match the commit/)
  assert.equal(
    calls.some((call) => call.command === 'docker'),
    false,
  )
})

test('a rerun for a fully published commit writes nothing', async () => {
  // The end state is the point, not the write: this script is for tight iteration, so rerunning
  // it on the same clean commit must be a no-op rather than a 412.
  const archiveKey = `runner/${REF}/${ARCHIVE}`
  const { builder, calls } = fakeBuilder({ staged: `${archiveKey}\t${archiveKey}.sha256` })
  await builder.execute({ stage: 'dev' })

  assert.deepEqual(
    calls.filter((call) => call.args[1] === 'put-object'),
    [],
  )
})

test('a half-published commit is reported, not silently completed', async () => {
  // The dangerous case. A rebuild is not byte-identical, so writing the absent manifest would
  // publish a digest for bytes that are not the stored ones — and because both keys would then
  // exist, write-once makes it unrepairable and every host fails the checksum instead.
  const archiveKey = `runner/${REF}/${ARCHIVE}`
  const { builder, calls } = fakeBuilder({ staged: archiveKey })

  await assert.rejects(builder.execute({ stage: 'dev' }), /partially published/)
  assert.deepEqual(
    calls.filter((call) => call.args[1] === 'put-object'),
    [],
    'nothing may be written over a partial publication',
  )
})

test('the repository root is resolved from this module, not the caller working directory', async () => {
  // Same reason artifacts/source.ts anchors its lookup: from a nested repository or submodule a
  // bare rev-parse answers for that one, and this call decides the commit the artifact is keyed to.
  const { builder, calls } = fakeBuilder()
  await builder.execute({ stage: 'dev' })

  const toplevel = calls.find((call) => call.args[0] === 'rev-parse' && call.args[1] === '--show-toplevel')
  assert.ok(toplevel, 'the root lookup is missing')
  // The anchor itself, not merely "some cwd": process.cwd() would satisfy a truthiness check
  // while reintroducing exactly the nested-repository hazard this pins.
  assert.equal(toplevel.options.cwd, fileURLToPath(new URL('.', import.meta.url)))
})

test('the printed next step scopes the ref to the Runner it just staged', () => {
  // This stages a Runner and nothing else. Printing the global BOXLITE_ARTIFACT_REF would also
  // point the Api at boxlite-app-<stage>-api:v<version>-<sha> — a tag only deploy-infra.yml pushes —
  // and the deploy would be refused at preflight with no image the developer could produce.
  // Read from source: main() runs only as a script, so nothing here can execute it.
  const source = readFileSync(fileURLToPath(new URL('./runner-build.ts', import.meta.url)), 'utf8')
  const printed = source.slice(source.indexOf('console.log(\n'))
  assert.match(printed, /RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=\$\{result\.ref\}/)
  assert.doesNotMatch(printed, /BOXLITE_ARTIFACT_(SOURCE|REF)/)
})
