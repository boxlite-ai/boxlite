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

import { removePulumiEventLogs, withPulumiEventLogCleanup } from './sst-event-log-security.mjs'

const SYNTHETIC_PROVIDER_TOKEN = 'synthetic-provider-token-for-regression-only'

async function fixtureRoot() {
  return mkdtemp(join(tmpdir(), 'boxlite-sst-event-log-security-'))
}

async function writeFixture(root, relativePath, content) {
  const filePath = join(root, relativePath)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content, 'utf8')
  return filePath
}

async function fileExists(filePath) {
  try {
    await readFile(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function waitForExit(child, timeoutMs = 5_000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
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

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'synthetic-test', '--stage', 'ci'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
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
    if (Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error) {
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
  let grandchildPid

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

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'synthetic-test', '--stage', 'ci'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
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
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic SST grandchild to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch (error) {
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
  let childPid

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

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'synthetic-test', '--stage', 'ci'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
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
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic SST child to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error) {
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

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_SST_CALLS_PATH, JSON.stringify(args) + '\\n')
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ stack: 'ci', latest: { resources: [] } }))
}
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'diff', '--stage', 'ci'], {
    cwd: infraRoot,
    env: {
      ...process.env,
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
    assert.deepEqual(calls, [
      ['state', 'export', '--stage', 'ci', '--print-logs'],
      ['diff', '--stage', 'ci', '--policy', infraRoot],
    ])
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})

test('interrupts a pending Runner state export when the wrapper is terminated', async () => {
  const fixture = await fixtureRoot()
  const fakeBin = join(fixture, 'bin')
  const fakeSst = join(fakeBin, 'sst')
  const childPidFile = join(fixture, 'state-export.pid')
  const infraRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  let childPid

  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
if (process.argv[2] !== 'state' || process.argv[3] !== 'export') process.exit(99)
writeFileSync(process.env.SYNTHETIC_SST_PID_PATH, String(process.pid))
// The wrapper must still terminate a state export that refuses graceful shutdown.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1_000)
`,
    'utf8',
  )
  await chmod(fakeSst, 0o755)

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'diff', '--stage', 'ci'], {
    cwd: infraRoot,
    env: {
      ...process.env,
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
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic state-export process to exit')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (error) {
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
  let curlPid

  await mkdir(fakeBin, { recursive: true })
  await writeFile(fakeSst, `#!/bin/sh\nprintf called > "$SYNTHETIC_SST_CALL_PATH"\n`, 'utf8')
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

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'deploy', '--stage', 'ci'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
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
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
    }, 'the synthetic release preflight to exit')
    assert.equal(await fileExists(sstCallFile), false, 'SST must not start after an interrupted release preflight')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    if (Number.isSafeInteger(curlPid)) {
      try {
        process.kill(curlPid, 'SIGKILL')
      } catch (error) {
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

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'diff', '--stage', 'ci', '--'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SST_BIN_PATH: fakeSst },
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
  const wrapperSource = await readFile(new URL('./sst-with-cloudflare.mjs', import.meta.url), 'utf8')
  const cleanupCall = 'withPulumiEventLogCleanup(PULUMI_EVENT_LOG_ROOT, runSstCommand)'
  const cleanupIndex = wrapperSource.indexOf(cleanupCall)
  const proxyVerificationIndex = wrapperSource.indexOf('await verifyProxyDeploymentWithRetry(')
  const publicVerificationIndex = wrapperSource.indexOf('await verifyPublicDeploymentWithRetry(')

  assert.match(
    wrapperSource,
    /import \{ removePulumiEventLogs, withPulumiEventLogCleanup \} from '\.\/sst-event-log-security\.mjs'/,
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
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!command.includes('sst')) continue
    assert.match(command, /scripts\/sst-with-cloudflare\.mjs/, `${name} bypasses the SST cleanup wrapper`)
  }
})

test('the infrastructure config check does not invoke SST outside the cleanup wrapper', async () => {
  const makeTargets = await readFile(new URL('../../../make/test.mk', import.meta.url), 'utf8')

  assert.doesNotMatch(makeTargets, /npm exec -- sst/)
  assert.match(makeTargets, /IAM_PERMISSIONS_BOUNDARY_STAGE=ci npm run sst -- install --stage ci/)
})
