// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { removePulumiEventLogs, withPulumiEventLogCleanup } from './pulumi-logs.js'
import { STAGE_CONFIG_BOOKKEEPING_KEYS, stageConfigDigest } from './stage-config.js'

/*
 * The lines a synthetic `sst secret list` prints, digest included.
 *
 * The wrapper refuses a manifest with no matching digest — that shape is a `secret load` that tore
 * between the two — so a fixture that omits it makes every one of these tests fail on the refusal
 * rather than on what it means to check. The digest comes from the production function for the same
 * reason bootstrap uses it: a hand-written constant here would be asserting the wrapper agrees with
 * this file rather than with bootstrap.
 */
function syntheticSecretList(manifest: readonly string[], values: Record<string, string>) {
  return [
    '# boxlite/ci',
    `BOXLITE_STAGE_CONFIG=${manifest.join(',')}`,
    `BOXLITE_STAGE_CONFIG_DIGEST=${stageConfigDigest(manifest, values)}`,
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  ]
}

const SYNTHETIC_PROVIDER_TOKEN = 'synthetic-provider-token-for-regression-only'
const INFRA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function spawnWrapper(args: any, options: any) {
  return spawn(process.execPath, ['--import', 'tsx', 'deployment/sst.ts', ...args], {
    cwd: INFRA_ROOT,
    ...options,
  })
}

async function fixtureRoot() {
  return mkdtemp(join(tmpdir(), 'boxlite-sst-event-log-security-'))
}

async function writeFixture(root: any, relativePath: any, content: any) {
  const filePath = join(root, relativePath)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content, 'utf8')
  return filePath
}

async function fileExists(filePath: any) {
  try {
    await readFile(filePath)
    return true
  } catch (error: any) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// These tests spawn the deploy wrapper and drive it with stubbed `aws`/`curl`/`sst` binaries, so
// the artifact mode they exercise has to be the one they state — never one inherited from the
// shell they happen to run in. `npm test` runs inside deploy-infra.yml's deploy job, which exports
// all four selectors at job scope; inheriting them puts the wrapper in build mode, where the Api
// preflight looks up a commit image, gets nothing back from the stubbed `aws`, and throws ~300ms
// in — before the release path these fixtures were written for is ever reached. The failure reads
// as a timeout because waitFor is still polling for a file the wrapper died before writing.
const ARTIFACT_SELECTOR_KEYS = [
  'BOXLITE_ARTIFACT_SOURCE',
  'API_ARTIFACT_SOURCE',
  'RUNNER_ARTIFACT_SOURCE',
  'BOXLITE_ARTIFACT_REF',
  'API_ARTIFACT_REF',
  'RUNNER_ARTIFACT_REF',
]

function inheritedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !ARTIFACT_SELECTOR_KEYS.includes(key)))
}

async function waitFor(predicate: any, description: any, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function waitForExit(child: any, timeoutMs = 5_000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code: any, signal: any) => resolve({ code, signal }))
    }),
    delay(timeoutMs).then(() => {
      throw new Error('Timed out waiting for the SST wrapper to exit')
    }),
  ])
}

test('removes nested Pulumi event logs without reading or deleting non-secret diagnostics', async () => {
  const root = await fixtureRoot()
  const eventLog = await writeFixture(
    root,
    'stage/update/eventlog.json',
    JSON.stringify({ provider: { apiToken: SYNTHETIC_PROVIDER_TOKEN } }),
  )
  const diagnostics = await writeFixture(root, 'stage/update/diagnostics.json', '{"status":"failed"}')
  const state = await writeFixture(root, 'stage/checkpoint/state.json', '{"resources":[]}')

  const removedCount = await removePulumiEventLogs(root)

  assert.equal(removedCount, 1)
  assert.equal(await fileExists(eventLog), false)
  assert.equal(await readFile(diagnostics, 'utf8'), '{"status":"failed"}')
  assert.equal(await readFile(state, 'utf8'), '{"resources":[]}')
})

test('cleans stale logs before a command and newly written logs after it succeeds', async () => {
  const root = await fixtureRoot()
  const staleLog = await writeFixture(root, 'old/eventlog.json', SYNTHETIC_PROVIDER_TOKEN)
  const generatedLog = join(root, 'new', 'eventlog.json')

  const result = await withPulumiEventLogCleanup(root, async () => {
    assert.equal(await fileExists(staleLog), false)
    await writeFixture(root, 'new/eventlog.json', SYNTHETIC_PROVIDER_TOKEN)
    return 23
  })

  assert.equal(result, 23)
  assert.equal(await fileExists(generatedLog), false)
})

test('cleans a generated event log when the wrapped command fails', async () => {
  const root = await fixtureRoot()
  const generatedLog = join(root, 'failed', 'eventlog.json')

  await assert.rejects(
    withPulumiEventLogCleanup(root, async () => {
      await writeFixture(root, 'failed/eventlog.json', SYNTHETIC_PROVIDER_TOKEN)
      throw new Error('synthetic command failure')
    }),
    /synthetic command failure/,
  )

  assert.equal(await fileExists(generatedLog), false)
})

test('cleans a generated event log before exiting after SIGTERM', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const pulumiRoot = new URL('../.sst/pulumi/', import.meta.url)
  const eventLog = join(pulumiRoot.pathname, `signal-test-${process.pid}-${Date.now()}`, 'eventlog.json')
  const childPidFile = join(fixture, 'sst-child.pid')
  let childPid

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
mkdirSync(dirname(process.env.SYNTHETIC_EVENT_LOG_PATH), { recursive: true })
writeFileSync(process.env.SYNTHETIC_SST_PID_PATH, String(process.pid))
writeFileSync(process.env.SYNTHETIC_EVENT_LOG_PATH, 'synthetic-provider-token-for-regression-only')
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['synthetic-test', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      SYNTHETIC_EVENT_LOG_PATH: eventLog,
      SYNTHETIC_SST_PID_PATH: childPidFile,
    },
    stdio: 'ignore',
  })

  try {
    await waitFor(() => fileExists(eventLog), 'the synthetic SST event log')
    childPid = Number.parseInt(await readFile(childPidFile, 'utf8'), 10)
    const wrapperExit = waitForExit(wrapper)
    wrapper.kill('SIGTERM')
    const result = await wrapperExit

    assert.equal(await fileExists(eventLog), false, 'SIGTERM must not leave the Pulumi event log behind')
    assert.deepEqual(result, { code: 143, signal: null })
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (typeof childPid === 'number' && Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error: any) {
        if (error.code !== 'ESRCH') console.warn(`failed to reap the synthetic SST child: ${error.message}`)
      }
    }
    await rm(dirname(eventLog), { recursive: true, force: true })
    await rm(fixture, { recursive: true, force: true })
  }
})

test('waits for native SST to cancel its detached Pulumi child before the wrapper exits', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const grandchildPidFile = join(fixture, 'sst-grandchild.pid')
  let grandchildPid: any

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', \`
  const { writeFileSync } = require('node:fs')
  writeFileSync(process.env.SYNTHETIC_SST_GRANDCHILD_PID_PATH, String(process.pid))
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
\`], { detached: true, stdio: 'ignore', env: process.env })
process.on('SIGINT', () => {
  grandchild.once('exit', () => process.exit(0))
  grandchild.kill('SIGINT')
})
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['synthetic-test', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      SYNTHETIC_SST_GRANDCHILD_PID_PATH: grandchildPidFile,
    },
    stdio: 'ignore',
  })

  try {
    await waitFor(() => fileExists(grandchildPidFile), 'the synthetic SST grandchild')
    grandchildPid = Number.parseInt(await readFile(grandchildPidFile, 'utf8'), 10)
    const wrapperExit = waitForExit(wrapper)
    wrapper.kill('SIGTERM')

    assert.deepEqual(await wrapperExit, { code: 143, signal: null })
    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0)
        return false
      } catch (error: any) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic SST grandchild to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch (error: any) {
        if (error.code !== 'ESRCH') console.warn(`failed to reap the synthetic SST grandchild: ${error.message}`)
      }
    }
    await rm(fixture, { recursive: true, force: true })
  }
})

test('force-stops native SST when repeated termination rejects graceful cancellation', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const childPidFile = join(fixture, 'sst-child.pid')
  const gracefulSignalFile = join(fixture, 'sst-graceful-signal')
  let childPid: any

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.SYNTHETIC_SST_PID_PATH, String(process.pid))
process.on('SIGINT', () => writeFileSync(process.env.SYNTHETIC_GRACEFUL_SIGNAL_PATH, 'received'))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['synthetic-test', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      SYNTHETIC_SST_PID_PATH: childPidFile,
      SYNTHETIC_GRACEFUL_SIGNAL_PATH: gracefulSignalFile,
    },
    stdio: 'ignore',
  })

  try {
    await waitFor(() => fileExists(childPidFile), 'the synthetic SST child')
    childPid = Number.parseInt(await readFile(childPidFile, 'utf8'), 10)
    const wrapperExit = waitForExit(wrapper)
    wrapper.kill('SIGTERM')
    await waitFor(() => fileExists(gracefulSignalFile), 'the first graceful SST interrupt')
    wrapper.kill('SIGTERM')

    assert.deepEqual(await wrapperExit, { code: 143, signal: null })
    await waitFor(() => {
      try {
        process.kill(childPid, 0)
        return false
      } catch (error: any) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic SST child to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error: any) {
        if (error.code !== 'ESRCH') console.warn(`failed to reap the synthetic SST child: ${error.message}`)
      }
    }
    await rm(fixture, { recursive: true, force: true })
  }
})

test('forwards one canonical Runner policy path to the SST process', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const capturedCalls = join(fixture, 'sst-calls.jsonl')
  const infraRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const policyRoot = join(infraRoot, 'policies/runner')

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_SST_CALLS_PATH, JSON.stringify(args) + '\\n')
if (args[0] === 'secret' && args[1] === 'list') {
  const NL = String.fromCharCode(10)
  process.stdout.write(${JSON.stringify(
    syntheticSecretList(['STACK_DOMAIN'], { STACK_DOMAIN: 'ci.example.test' }),
  )}.join(NL) + NL)
  process.exit(0)
}
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
}
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      RUNNERS: '1',
      DEFAULT_RUNNER_NAME: 'default',
      SYNTHETIC_SST_CALLS_PATH: capturedCalls,
    },
    stdio: 'ignore',
  })

  try {
    assert.deepEqual(await waitForExit(wrapper), { code: 0, signal: null })
    const calls = (await readFile(capturedCalls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // The store read comes first and exactly once: everything after it — the Runner state baseline
    // and the diff itself — is planned from the configuration it loads, so a second read would mean
    // two answers for one command, and a later one would mean the plan was built without it.
    assert.deepEqual(calls, [
      ['secret', 'list', '--stage', 'ci'],
      ['state', 'export', '--stage', 'ci', '--print-logs'],
      ['diff', '--stage', 'ci', '--policy', policyRoot],
    ])
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

/*
 * The store shapes the wrapper must refuse, each driven end to end.
 *
 * Seven shapes across the wrapper's six refusals, not one apiece: an absent digest and a mismatched one
 * meet the same comparison, covered as two shapes because they arise from different accidents and a
 * reader would otherwise assume only one is handled. The other five — unreadable, no manifest, a
 * manifested value the store lacks, a removed key, and a manifest that applies nothing — get one
 * shape each.
 *
 * They need the wrapper rather than a unit test: hydrateStageConfig can show a shape is detectable,
 * never that anything acts on it. Counting `process.exit(1)` in the source proves refusals exist; it
 * cannot prove which shape reaches which.
 *
 * Two things make each case prove its own branch rather than merely "something refused".
 *
 * The digest is stated explicitly: a placeholder makes every fixture trip the mismatch branch first,
 * so the test passes while the branch it names is dead — which is what a first draft did, and what
 * disabling a later refusal failed to reveal.
 *
 * And each case matches the wrapper's own message. Exit 1 is shared by all six, and the guards sit in
 * a chain where removing one usually lets the next catch the same fixture — so the exit code cannot
 * distinguish them, and a test that only checks it stays green through the regression it exists for.
 */
type RefusedStore = {
  description: string
  manifest?: string[]
  values: Record<string, string>
  digest: 'correct' | 'wrong' | 'omit'
  // The store cannot be read at all — `sst secret list` itself fails.
  listFails?: true
  // A fragment of the refusal this shape must produce, distinct from every other guard's.
  refusal: RegExp
}

const REFUSED_STORES: RefusedStore[] = [
  {
    /*
     * Not a store at all: `sst secret list` exits non-zero, as it does on a stage that was never
     * bootstrapped or when AWS is unreachable. Its own guard, and the earliest one — everything below
     * assumes a store that read cleanly.
     */
    description: 'a store that cannot be read',
    values: {},
    digest: 'omit',
    listFails: true,
    refusal: /could not read the ci stage configuration/,
  },
  {
    // Torn between the values and the digest — every manifest name present, so only the digest sees it.
    description: 'a manifested store with no digest',
    manifest: ['STACK_DOMAIN'],
    values: { STACK_DOMAIN: 'torn.example.test' },
    digest: 'omit',
    refusal: /carries no BOXLITE_STAGE_CONFIG_DIGEST/,
  },
  {
    // A digest that describes a different generation: the interrupted read-modify-write.
    description: 'a digest that does not match the values',
    manifest: ['STACK_DOMAIN'],
    values: { STACK_DOMAIN: 'mixed.example.test' },
    digest: 'wrong',
    refusal: /does not match its BOXLITE_STAGE_CONFIG_DIGEST/,
  },
  {
    // Values but no manifest: never bootstrapped, or the manifest was removed. Hydration would be a
    // no-op and the deploy would reconcile against whatever the defaults are.
    description: 'a store with no manifest at all',
    values: { STACK_DOMAIN: 'unmanifested.example.test' },
    digest: 'omit',
    refusal: /has no BOXLITE_STAGE_CONFIG manifest/,
  },
  {
    // The manifest names a key the store does not hold — a half-written load. The digest is correct
    // for what IS there, so this reaches the missing-value branch rather than the mismatch one.
    description: 'a manifest naming a value the store lacks',
    manifest: ['STACK_DOMAIN', 'APP_URL'],
    values: { STACK_DOMAIN: 'partial.example.test' },
    digest: 'correct',
    refusal: /is incomplete/,
  },
  {
    /*
     * A manifest naming only keys that are refused: the store reads as populated and applies nothing.
     * AWS_PROFILE rather than a process control — it is refused for the same reason and proves the same
     * branch, but if a regression ever did hydrate it the worst case is a wrong AWS profile. A
     * NODE_OPTIONS payload would instead name a file node executes at startup, making the fixture a
     * preload primitive, and a child dying on the missing file would satisfy both assertions here
     * without the refusal ever running.
     */
    description: 'a manifest that applies nothing',
    manifest: ['AWS_PROFILE'],
    values: { AWS_PROFILE: 'synthetic-refused-profile' },
    digest: 'correct',
    refusal: /applied nothing/,
  },
  {
    // A key removed from the ClickHouse contract must not silently fall back to the new fixed
    // value. The manifest proves the stage was configured under the older contract, so deploying
    // it without a fresh bootstrap would apply a topology the operator never reviewed.
    description: 'a manifest naming removed ClickHouse configuration',
    manifest: ['STACK_DOMAIN', 'CLICKHOUSE_RETENTION_HOURS'],
    values: {
      STACK_DOMAIN: 'configured.example.test',
      CLICKHOUSE_RETENTION_HOURS: '168',
    },
    digest: 'correct',
    refusal: /CLICKHOUSE_RETENTION_HOURS is no longer supported/,
  },
]

function refusedStoreLines({ manifest, values, digest }: RefusedStore) {
  const lines = ['# boxlite/ci']
  if (manifest) lines.push(`BOXLITE_STAGE_CONFIG=${manifest.join(',')}`)
  if (digest === 'correct') lines.push(`BOXLITE_STAGE_CONFIG_DIGEST=${stageConfigDigest(manifest ?? [], values)}`)
  if (digest === 'wrong') lines.push(`BOXLITE_STAGE_CONFIG_DIGEST=${'0'.repeat(64)}`)
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${value}`)
  return lines
}

for (const refusedStore of REFUSED_STORES) {
  const { description, refusal } = refusedStore
  test(`${description} stops the deploy before sst runs`, async () => {
    const fixture = await fixtureRoot()
    const fakeBin = join(fixture, 'bin')
    const fakeSst = join(fakeBin, 'sst')
    const capturedEnv = join(fixture, 'child-env.json')

    await mkdir(fakeBin, { recursive: true })
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  ${refusedStore.listFails ? 'process.exit(7)' : `process.stdout.write(${JSON.stringify(refusedStoreLines(refusedStore))}.join(String.fromCharCode(10)) + String.fromCharCode(10))`}
  process.exit(0)
}
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
  process.exit(0)
}
writeFileSync(process.env.SYNTHETIC_ENV_PATH, JSON.stringify(process.env))
`,
      'utf8',
    )
    await chmod(fakeSst, 0o755)

    const wrapper = spawnWrapper(['diff', '--stage', 'ci'], {
      env: {
        ...inheritedEnvironment(),
        PATH: `${fakeBin}:${process.env.PATH}`,
        SST_BIN_PATH: fakeSst,
        CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
        CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
        RUNNERS: '1',
        DEFAULT_RUNNER_NAME: 'default',
        SYNTHETIC_ENV_PATH: capturedEnv,
      },
      stdio: ['ignore', 'inherit', 'pipe'],
    })

    /*
     * Drained to close, not just to exit. `exit` fires when the process ends, which can be before the
     * pipe has delivered what it wrote — so asserting on the buffer at that moment reads however much
     * happened to arrive, and the message checks below would fail intermittently on a machine under
     * load. `close` is the event that means "and its stdio is finished".
     */
    let stderr = ''
    wrapper.stderr.setEncoding('utf8')
    wrapper.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const stderrDrained = new Promise<void>((resolve) => wrapper.stderr.once('close', () => resolve()))

    try {
      const exit = await waitForExit(wrapper)
      await stderrDrained
      assert.deepEqual(exit, { code: 1, signal: null }, `${description} must be refused`)
      assert.match(stderr, refusal, `${description} must be refused by its own guard, not a later one`)
      /*
       * And no OTHER guard spoke. Matching only the expected message proves this guard ran, not that it
       * is what stopped the deploy: delete just its `process.exit(1)` and the message still prints
       * while the next guard down the chain exits, satisfying both assertions above. Requiring silence
       * from the others is what makes the exit attributable to this one.
       */
      for (const other of REFUSED_STORES) {
        if (other.refusal.source === refusal.source) continue
        assert.doesNotMatch(stderr, other.refusal, `${description} must not fall through to ${other.description}`)
      }
      /*
       * And it exited deliberately rather than crashing. Node exits 1 on an unhandled throw too, so
       * without this the unreadable-store case passes with its guard deleted: `stored` stays undefined,
       * hydration throws a TypeError, and every assertion above is satisfied by a stack trace.
       */
      assert.doesNotMatch(stderr, /^\s+at |\b(TypeError|ReferenceError|SyntaxError)\b/m, `${description} must be refused, not crashed`)
      // The fake sst writes that file only on its fall-through, so its absence is the proof no plan was
      // ever started — the refusal has to land before sst is asked to build anything.
      assert.equal(await fileExists(capturedEnv), false, `sst must not run with ${description}`)
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test('a stored stage configuration reaches the spawned SST process', async () => {
  // The end-to-end claim the unit tests cannot make: a value that exists only in the secret store is
  // read by the wrapper and present in the environment of the sst child that builds the plan. The
  // fake sst answers `secret list` with a store and then records its own environment.
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const capturedEnv = join(fixture, 'child-env.json')

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  // String.fromCharCode(10), not an escape: this script lives in a template literal, so a
  // backslash-n would be resolved before the file is written and leave a real newline inside a
  // string literal — which is a syntax error in the generated script, not a line separator.
  const NL = String.fromCharCode(10)
  process.stdout.write(${JSON.stringify([
    ...syntheticSecretList(['STACK_DOMAIN', 'APP_URL', 'NODE_OPTIONS'], {
      STACK_DOMAIN: 'stored.example.test',
      APP_URL: 'https://stored.example.test',
      NODE_OPTIONS: '--require /tmp/synthetic-evil.js',
    }),
    // Present in the store but absent from the manifest, so outside the digest as well as hydration.
    'PROXY_DOMAIN=stale.example.test',
  ])}.join(NL) + NL)
  process.exit(0)
}
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
  process.exit(0)
}
writeFileSync(process.env.SYNTHETIC_ENV_PATH, JSON.stringify(process.env))
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      RUNNERS: '1',
      DEFAULT_RUNNER_NAME: 'default',
      APP_URL: 'https://environment-wins.example.test',
      SYNTHETIC_ENV_PATH: capturedEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  try {
    assert.deepEqual(await waitForExit(wrapper), { code: 0, signal: null })
    const childEnv = JSON.parse(await readFile(capturedEnv, 'utf8'))
    assert.equal(childEnv.STACK_DOMAIN, 'stored.example.test', 'a stored value must reach the sst child')
    assert.equal(childEnv.APP_URL, 'https://environment-wins.example.test', 'the environment must beat the store')
    assert.equal(childEnv.PROXY_DOMAIN, undefined, 'a key off the manifest must not be hydrated')
    assert.equal(childEnv.NODE_OPTIONS, undefined, 'a process control must not be hydrated even if manifested')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('an unreadable stage configuration store stops every command that builds a plan', async () => {
  // `diff` included, though it only reads. A preview built from defaults is not a preview of the
  // deploy that follows: the operator approves that plan, the apply then reads the store fine, and
  // reconciles something nobody reviewed. Both fail or neither does.
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const planCalled = join(fixture, 'plan-called')

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') process.exit(7)
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
  process.exit(0)
}
writeFileSync(process.env.SYNTHETIC_PLAN_PATH, args[0])
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const environment = {
    ...inheritedEnvironment(),
    PATH: `${fakeBin}:${process.env.PATH}`,
    SST_BIN_PATH: fakeSst,
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
    RUNNERS: '1',
    DEFAULT_RUNNER_NAME: 'default',
    SYNTHETIC_PLAN_PATH: planCalled,
  }

  try {
    const deploying = spawnWrapper(['deploy', '--stage', 'ci'], { env: environment, stdio: 'ignore' })
    assert.deepEqual(await waitForExit(deploying), { code: 1, signal: null }, 'a deploy must stop when the store cannot be read')
    assert.equal(await fileExists(planCalled), false, 'no plan may run without the stage configuration')

    // Each subcommand individually rather than assumed from `deploy`: remove tears the stack down,
    // refresh rewrites its state, and diff feeds the review the apply is judged against.
    for (const writing of ['remove', 'refresh']) {
      const child = spawnWrapper([writing, '--stage', 'ci'], { env: environment, stdio: 'ignore' })
      assert.deepEqual(
        await waitForExit(child),
        { code: 1, signal: null },
        `${writing} writes, so it must stop when the store cannot be read`,
      )
      assert.equal(await fileExists(planCalled), false, `${writing} must not reach sst`)
    }

    const diffing = spawnWrapper(['diff', '--stage', 'ci'], { env: environment, stdio: 'ignore' })
    assert.deepEqual(
      await waitForExit(diffing),
      { code: 1, signal: null },
      'a preview against defaults would not describe the deploy that follows it',
    )
    assert.equal(await fileExists(planCalled), false, 'no plan may run without the stage configuration')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a failed store read never repeats what sst printed', async () => {
  // execFileSync builds its error message from the failed command line and the captured stdio, and
  // for `secret list` that output is the store's contents. The wrapper must report the exit status
  // only. The fake sst fails after printing a recognisable secret to both streams, and neither may
  // appear in anything the wrapper writes.
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const leaked = 'synthetic-store-value-that-must-not-be-echoed'

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  process.stdout.write('STACK_DOMAIN=${leaked}')
  process.stderr.write('sst: ${leaked}')
  process.exit(9)
}
process.exit(0)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      RUNNERS: '1',
      DEFAULT_RUNNER_NAME: 'default',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let captured = ''
  wrapper.stdout.on('data', (chunk: any) => {
    captured += chunk
  })
  wrapper.stderr.on('data', (chunk: any) => {
    captured += chunk
  })

  try {
    await waitForExit(wrapper)
    assert.ok(captured.includes('could not read the ci stage configuration'), 'the failure must still be reported')
    assert.equal(captured.includes(leaked), false, "the wrapper must not repeat sst's captured output")
    assert.ok(captured.includes('sst exited 9'), 'the exit status is what identifies the failure')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('npm run secrets prints names without values or the manifest', async () => {
  // The command exists because `sst secret list` inherited sst's stdio and printed every value, which
  // now means the whole stage configuration. Asserted at the CLI, not on the parser: the leak this
  // replaces was in how the process was wired, so only running it proves anything.
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const value = 'synthetic-value-that-must-stay-hidden'

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  const NL = String.fromCharCode(10)
  process.stdout.write(${JSON.stringify([
    ...syntheticSecretList(['STACK_DOMAIN'], { STACK_DOMAIN: value }),
    // An app secret sst resolves itself; named by nothing here, so never hydrated.
    `OIDC_CLIENT_ID=${value}`,
  ])}.join(NL) + NL)
  process.exit(0)
}
process.exit(0)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const listing = spawn(process.execPath, ['--import', 'tsx', 'deployment/secret-names.ts', '--stage', 'ci'], {
    cwd: INFRA_ROOT,
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  listing.stdout.on('data', (chunk: any) => {
    output += chunk
  })
  listing.stderr.on('data', (chunk: any) => {
    output += chunk
  })

  try {
    assert.deepEqual(await waitForExit(listing), { code: 0, signal: null })
    assert.ok(output.includes('STACK_DOMAIN'), 'the names are the point of the command')
    assert.ok(output.includes('OIDC_CLIENT_ID'), 'an app secret is still worth listing by name')
    assert.equal(output.includes(value), false, 'no value may be printed')
    // Each bookkeeping key by name, from the exported list. A single `includes('BOXLITE_STAGE_CONFIG')`
    // passed for the wrong reason once the digest key arrived: its name contains the manifest's, so the
    // check could not tell "neither is printed" from "one of them is".
    for (const bookkeeping of STAGE_CONFIG_BOOKKEEPING_KEYS) {
      assert.equal(output.includes(bookkeeping), false, `${bookkeeping} is bookkeeping, not a secret`)
    }

    // Spawning the script directly proves the script is safe, not that `npm run secrets` uses it.
    // Without this, restoring the old `sst secret list` wiring — the leak this replaced — stays green.
    const scripts = JSON.parse(await readFile(join(INFRA_ROOT, 'package.json'), 'utf8')).scripts
    assert.equal(scripts.secrets, 'tsx deployment/secret-names.ts')
  } finally {
    if (listing.exitCode === null && listing.signalCode === null) listing.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('interrupts a pending Runner state export when the wrapper is terminated', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const childPidFile = join(fixture, 'state-export.pid')
  let childPid: any

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  const NL = String.fromCharCode(10)
  process.stdout.write(${JSON.stringify(
    syntheticSecretList(['STACK_DOMAIN'], { STACK_DOMAIN: 'ci.example.test' }),
  )}.join(NL) + NL)
  process.exit(0)
}
if (args[0] !== 'state' || args[1] !== 'export') process.exit(99)
writeFileSync(process.env.SYNTHETIC_SST_PID_PATH, String(process.pid))
// The wrapper must still terminate a state export that refuses graceful shutdown.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      SYNTHETIC_SST_PID_PATH: childPidFile,
    },
    stdio: 'ignore',
  })

  try {
    await waitFor(() => fileExists(childPidFile), 'the synthetic state-export process')
    childPid = Number.parseInt(await readFile(childPidFile, 'utf8'), 10)
    const wrapperExit = waitForExit(wrapper)
    wrapper.kill('SIGTERM')

    assert.deepEqual(await wrapperExit, { code: 143, signal: null })
    await waitFor(() => {
      try {
        process.kill(childPid, 0)
        return false
      } catch (error: any) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic state-export process to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error: any) {
        if (error.code !== 'ESRCH') console.warn(`failed to reap the synthetic SST child: ${error.message}`)
      }
    }
    await rm(fixture, { recursive: true, force: true })
  }
})

test('interrupts Runner release preflight without starting SST', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const fakeAws = join(fakeBin, 'aws')
  const fakeCurl = join(fakeBin, 'curl')
  const curlPidFile = join(fixture, 'curl.pid')
  const sstCallFile = join(fixture, 'sst-called')
  let curlPid: any

  await mkdir(fakeBin, { recursive: true })
  // Records what it was asked to do, not merely that it ran: the wrapper legitimately reads the
  // stage's configuration out of the secret store before the preflight, so "sst was never spawned"
  // is no longer the property under test. What must hold is that nothing which MUTATES the stack
  // ran — asserted below on the recorded subcommands.
  //
  // `secret list` answers with a manifest because a deploy against a store that names nothing now
  // stops before it reaches the preflight this test is about.
  await writeFile(
    fakeSst,
    `#!/bin/sh
echo "$@" >> "$SYNTHETIC_SST_CALL_PATH"
if [ "$1" = "secret" ] && [ "$2" = "list" ]; then
${syntheticSecretList(['STACK_DOMAIN'], { STACK_DOMAIN: 'ci.example.test' })
  .map((line) => `  echo ${JSON.stringify(line)}`)
  .join('\n')}
fi
`,
    'utf8',
  )
  await writeFile(fakeAws, '#!/bin/sh\nexit 0\n', 'utf8')
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.SYNTHETIC_CURL_PID_PATH, String(process.pid))
// The wrapper must reap the preflight even when it refuses graceful shutdown.
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await Promise.all([chmod(fakeSst, 0o755), chmod(fakeAws, 0o755), chmod(fakeCurl, 0o755)])

  const wrapper = spawnWrapper(['deploy', '--stage', 'ci'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      AWS_CLI_PATH: fakeAws,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      IAM_PERMISSIONS_BOUNDARY_STAGE: 'ci',
      OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
      STACK_DOMAIN: 'ci.example.test',
      SYNTHETIC_CURL_PID_PATH: curlPidFile,
      SYNTHETIC_SST_CALL_PATH: sstCallFile,
    },
    stdio: 'ignore',
  })

  try {
    await waitFor(() => fileExists(curlPidFile), 'the synthetic release preflight')
    curlPid = Number.parseInt(await readFile(curlPidFile, 'utf8'), 10)
    const wrapperExit = waitForExit(wrapper)
    wrapper.kill('SIGTERM')

    assert.deepEqual(await wrapperExit, { code: 143, signal: null })
    await waitFor(() => {
      try {
        process.kill(curlPid, 0)
        return false
      } catch (error: any) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic release preflight to exit')
    const sstInvocations = (await fileExists(sstCallFile))
      ? (await readFile(sstCallFile, 'utf8')).trim().split('\n').filter(Boolean)
      : []
    // Reading the store is fine and expected; nothing else is. Matched on the whole invocation rather
    // than its first word, because `secret set`, `secret load` and `secret remove` all write — an
    // assertion that allowed any `secret` subcommand would have passed them too.
    const unexpected = sstInvocations.filter((invocation) => !/^secret list( |$)/.test(invocation))
    assert.deepEqual(
      unexpected,
      [],
      `only \`secret list\` may run after an interrupted release preflight (ran: ${sstInvocations.join(' | ')})`,
    )
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(curlPid)) {
      try {
        process.kill(curlPid, 'SIGKILL')
      } catch (error: any) {
        if (error.code !== 'ESRCH') console.warn(`failed to reap the synthetic curl process: ${error.message}`)
      }
    }
    await rm(fixture, { recursive: true, force: true })
  }
})

test('rejects an argument delimiter before guarded SST commands start', async () => {
  const fixture = await fixtureRoot()
  const fakeSst = await writeFixture(fixture, 'sst', '#!/bin/sh\nexit 99\n')
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci', '--'], {
    env: { ...inheritedEnvironment(), SST_BIN_PATH: fakeSst },
    stdio: 'ignore',
  })

  try {
    assert.deepEqual(await waitForExit(wrapper), { code: 1, signal: null })
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('the Cloudflare wrapper cleans immediately after SST before post-deploy verification', async () => {
  const wrapperSource = await readFile(new URL('./sst.ts', import.meta.url), 'utf8')
  const cleanupCall = 'withPulumiEventLogCleanup(PULUMI_EVENT_LOG_ROOT, runSstCommand)'
  const cleanupIndex = wrapperSource.indexOf(cleanupCall)
  const proxyVerificationIndex = wrapperSource.indexOf('await verifyProxyDeploymentWithRetry(')
  const publicVerificationIndex = wrapperSource.indexOf('await verifyPublicDeploymentWithRetry(')

  assert.match(
    wrapperSource,
    /import \{ removePulumiEventLogs, withPulumiEventLogCleanup \} from '\.\/pulumi-logs\.js'/,
  )
  assert.match(wrapperSource, /async function runSstCommand\(\)[\s\S]*spawn\(sstExecutable, sstArgs/)
  assert.match(
    wrapperSource,
    /process\.on\(signal,[\s\S]*sstProcessTerminator\.forceStop\(\)[\s\S]*sstProcessTerminator\.interrupt\(\)/,
  )
  assert.notEqual(cleanupIndex, -1)
  assert.ok(cleanupIndex < proxyVerificationIndex)
  assert.ok(cleanupIndex < publicVerificationIndex)
})

test('package scripts do not bypass the cleanup wrapper or enable SST dev', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  assert.equal(packageJson.scripts.dev, undefined)
  for (const [name, command] of Object.entries(packageJson.scripts) as Array<[string, string]>) {
    if (!command.includes('sst')) continue
    assert.match(command, /deployment\/sst\.ts/, `${name} bypasses the SST cleanup wrapper`)
  }
})

test('materializes aws login credentials before spawning SST', async () => {
  const fixture = await fixtureRoot()
  const fakeAws = await writeFixture(
    fixture,
    'aws',
    `#!/bin/sh
if [ "$1 $2 $3" = "configure get login_session" ]; then
  printf '%s\n' 'arn:aws:iam::123456789012:user/synthetic-console-session'
  exit 0
fi
printf '%s\n' "$*" > "$SYNTHETIC_AWS_CALL_PATH"
printf '%s\n' '{"Version":1,"AccessKeyId":"SYNTHETIC_ACCESS_KEY","SecretAccessKey":"SYNTHETIC_SECRET_KEY","SessionToken":"SYNTHETIC_SESSION_TOKEN","Expiration":"2099-01-01T00:00:00Z"}'
`,
  )
  const fakeSst = await writeFixture(
    fixture,
    'sst',
    `#!/bin/sh
printf '%s|%s|%s|%s\n' "\${AWS_ACCESS_KEY_ID:-missing}" "\${AWS_SECRET_ACCESS_KEY:-missing}" "\${AWS_SESSION_TOKEN:-missing}" "\${AWS_PROFILE:-unset}" > "$SYNTHETIC_SST_ENV_PATH"
`,
  )
  const awsCallPath = join(fixture, 'aws-call')
  const sstEnvironmentPath = join(fixture, 'sst-environment')
  await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

  const environment = inheritedEnvironment()
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete environment[key]
  const wrapper = spawnWrapper(['secret', 'list', '--stage', 'ci'], {
    env: {
      ...environment,
      AWS_PROFILE: 'console-session',
      AWS_CLI_PATH: fakeAws,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      SYNTHETIC_AWS_CALL_PATH: awsCallPath,
      SYNTHETIC_SST_ENV_PATH: sstEnvironmentPath,
    },
    stdio: 'ignore',
  })

  try {
    assert.deepEqual(await waitForExit(wrapper), { code: 0, signal: null })
    assert.equal(
      await readFile(awsCallPath, 'utf8'),
      'configure export-credentials --format process --profile console-session\n',
    )
    assert.equal(
      await readFile(sstEnvironmentPath, 'utf8'),
      'SYNTHETIC_ACCESS_KEY|SYNTHETIC_SECRET_KEY|SYNTHETIC_SESSION_TOKEN|unset\n',
    )
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('the infrastructure config check does not invoke SST outside the cleanup wrapper', async () => {
  const makeTargets = await readFile(new URL('../../../make/test.mk', import.meta.url), 'utf8')

  assert.doesNotMatch(makeTargets, /npm exec -- sst/)
  assert.match(makeTargets, /IAM_PERMISSIONS_BOUNDARY_STAGE=ci npm run sst -- install --stage ci/)
})

test('the wrapper keeps its own progress off the stream sst writes its plan to', async () => {
  /*
   * `sst diff --json` is piped straight into a JSON parser by the deploy workflow's preview step, and
   * the wrapper spawns sst with `stdio: 'inherit'` — so stdout is one shared stream, and a progress
   * line the wrapper prints lands in that pipe ahead of the plan. It fails the parse on its first
   * character, reported as an invalid preview rather than as anything about the deploy: run
   * 31880617031 died on `Unexpected token 's', "sst-with-c"...` with a plan that was fine.
   *
   * Driven through the wrapper because the coupling is between two processes: the messages are the
   * wrapper's, the stream discipline is the child's, and nothing in either half alone shows that one
   * corrupts the other.
   */
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const plan = { steps: [], summary: { same: 3 } }

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'secret' && args[1] === 'list') {
  const NL = String.fromCharCode(10)
  process.stdout.write(${JSON.stringify(
    syntheticSecretList(['STACK_DOMAIN', 'APP_URL'], {
      STACK_DOMAIN: 'stored.example.test',
      APP_URL: 'https://stored.example.test',
    }),
  )}.join(NL) + NL)
  process.exit(0)
}
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
  process.exit(0)
}
// The plan, on the stream the preview step parses.
process.stdout.write(JSON.stringify(${JSON.stringify(plan)}))
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawnWrapper(['diff', '--stage', 'ci', '--json'], {
    env: {
      ...inheritedEnvironment(),
      PATH: `${fakeBin}:${process.env.PATH}`,
      SST_BIN_PATH: fakeSst,
      CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account',
      RUNNERS: '1',
      DEFAULT_RUNNER_NAME: 'default',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  /*
   * Drained to close, not just to exit, for the reason spelled out at the refusal fixtures above —
   * `exit` can fire before the pipe has delivered what was written. It matters more here than there:
   * a short read makes `JSON.parse` throw the same SyntaxError a genuine stdout leak produces, so a
   * flake on a loaded machine would be indistinguishable from the bug this test exists to catch.
   */
  let stdout = ''
  let stderr = ''
  wrapper.stdout.setEncoding('utf8')
  wrapper.stderr.setEncoding('utf8')
  wrapper.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  wrapper.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const streamsDrained = Promise.all([
    new Promise<void>((resolve) => wrapper.stdout.once('close', () => resolve())),
    new Promise<void>((resolve) => wrapper.stderr.once('close', () => resolve())),
  ])

  try {
    const exit = await waitForExit(wrapper)
    await streamsDrained
    assert.deepEqual(exit, { code: 0, signal: null })
    // The whole stream, parsed the way the preview step parses it — not a substring search, which
    // would pass with a progress line sitting in front of the plan.
    assert.deepEqual(
      JSON.parse(stdout),
      plan,
      `stdout must carry sst's plan and nothing else, but the preview step would parse: ${stdout.slice(0, 120)}`,
    )
    /*
     * And the messages still exist. Without this the wrapper could pass by having gone silent, which
     * is a different regression — the deploy log is where an operator sees which keys were loaded.
     */
    assert.match(stderr, /sst-with-cloudflare: ci stage configuration \.\.\. 2 keys loaded/)
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})
