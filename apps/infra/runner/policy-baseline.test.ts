// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { executeStateExportProcess, readRunnerStateBaseline } from './policy-baseline.js'
// eslint-disable-next-line @nx/enforce-module-boundaries -- This test exercises the policy host's CommonJS Runner model.
import runnerInventory from './model/inventory.js'

const { CONTROL_PLANE_NAME_TAG } = runnerInventory
const SAFE_BASELINE_HANDOFF_BYTES = 32 * 1024

function runnerStateResource(index: any) {
  const isDefaultRunner = index === 1
  const resourceName = isDefaultRunner ? 'Runner' : `Runner-runner-${index}`
  const nameTag = isDefaultRunner ? 'boxlite-runner-default' : `boxlite-runner-${index}`
  const controlPlaneRunnerName = isDefaultRunner ? 'default' : `runner-${index}`
  return {
    urn: `urn:pulumi:dev::boxlite::aws:ec2/instance:Instance::${resourceName}`,
    type: 'aws:ec2/instance:Instance',
    custom: true,
    id: `i-runner-${index}`,
    inputs: {
      instanceType: 'c8i.2xlarge',
      tags: {
        Name: nameTag,
        [CONTROL_PLANE_NAME_TAG]: controlPlaneRunnerName,
      },
    },
    provider: 'urn:pulumi:dev::boxlite::pulumi:providers:aws::AwsProvider::provider-id',
    protect: true,
    ignoreChanges: ['ami', 'userDataBase64'],
  }
}

test('exports the matching SST checkpoint with bounded, cancellable execution', async () => {
  const calls: any[] = []
  const controller = new AbortController()
  const environment = { PATH: '/synthetic/bin' }
  const baseline = await readRunnerStateBaseline({
    stage: 'dev',
    sstArgs: ['diff', '--stage', 'dev', '--config=infra/sst.config.ts'],
    environment,
    signal: controller.signal,
    async execute(command: any, args: any, options: any) {
      calls.push({ command, args, options })
      return { stdout: JSON.stringify({ stack: 'dev', latest: { resources: [] } }), stderr: '' }
    },
  })

  assert.deepEqual(JSON.parse(baseline), { version: 3, resources: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'sst')
  assert.deepEqual(calls[0].args, [
    'state',
    'export',
    '--stage',
    'dev',
    '--print-logs',
    '--config',
    'infra/sst.config.ts',
  ])
  assert.equal(calls[0].options.env, environment)
  assert.equal(calls[0].options.signal, controller.signal)
  assert.equal(calls[0].options.timeout, 300_000)
  assert.equal(calls[0].options.maxBuffer, 64 * 1024 * 1024)
})

test('represents an explicitly missing SST stage as an empty Runner baseline', async () => {
  const baseline = await readRunnerStateBaseline({
    stage: 'new-stage',
    sstArgs: ['diff', '--stage', 'new-stage'],
    async execute() {
      throw Object.assign(new Error('synthetic missing state'), {
        code: 1,
        stderr: 'time=synthetic level=ERROR msg="exited with error" err="state not found"\n',
      })
    },
  })

  assert.deepEqual(JSON.parse(baseline), { version: 3, resources: {} })
})

test('keeps the maximum supported Runner inventory within the safe environment handoff size', async () => {
  const resources = Array.from({ length: 100 }, (_, offset) => runnerStateResource(offset + 1))
  const baseline = await readRunnerStateBaseline({
    stage: 'dev',
    sstArgs: ['diff', '--stage', 'dev'],
    async execute() {
      return { stdout: JSON.stringify({ latest: { resources } }), stderr: '' }
    },
  })

  assert.equal(JSON.parse(baseline).version, 3)
  assert.equal(Object.keys(JSON.parse(baseline).resources).length, 100)
  assert.ok(Buffer.byteLength(baseline, 'utf8') < SAFE_BASELINE_HANDOFF_BYTES)
})

test('rejects an oversized Runner baseline before the environment handoff', async () => {
  const resources = Array.from({ length: 400 }, (_, offset) => runnerStateResource(offset + 1))

  await assert.rejects(
    readRunnerStateBaseline({
      stage: 'dev',
      sstArgs: ['diff', '--stage', 'dev'],
      async execute() {
        return { stdout: JSON.stringify({ latest: { resources } }), stderr: '' }
      },
    }),
    /Runner state baseline exceeds the 32 KiB environment handoff limit/,
  )
})

for (const [name, failure] of [
  [
    'aborted',
    Object.assign(new Error('synthetic abort'), {
      name: 'AbortError',
    }),
  ],
  [
    'killed',
    Object.assign(new Error('synthetic kill'), {
      killed: true,
      signal: 'SIGKILL',
    }),
  ],
  [
    'timed-out',
    Object.assign(new Error('synthetic timeout'), {
      code: 'ETIMEDOUT',
    }),
  ],
  [
    'maxBuffer-terminated',
    Object.assign(new Error('synthetic maxBuffer failure'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    }),
  ],
  [
    'signal-terminated',
    Object.assign(new Error('synthetic signal termination'), {
      signal: 'SIGTERM',
    }),
  ],
]) {
  test(`does not treat ${name} state export failure as a missing SST stage`, async () => {
    ;(failure as any).stderr = 'time=synthetic level=ERROR msg="exited with error" err="state not found"\n'

    await assert.rejects(
      readRunnerStateBaseline({
        stage: 'dev',
        sstArgs: ['diff', '--stage', 'dev'],
        async execute() {
          throw failure
        },
      }),
      /failed to export the current SST state/,
    )
  })
}

test('interrupts a state export that exceeds its timeout', async () => {
  await assert.rejects(
    executeStateExportProcess(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      encoding: 'utf8',
      env: process.env,
      timeout: 50,
      maxBuffer: 1024 * 1024,
    }),
    (error: any) => {
      assert.equal(error.killed, true)
      return true
    },
  )
})

test(
  'force-stops a read-only state export that ignores the graceful interrupt',
  { skip: process.platform === 'win32' },
  async () => {
    const startedAt = Date.now()

    await assert.rejects(
      executeStateExportProcess('/bin/sh', ['-c', "trap '' INT; sleep 3"], {
        encoding: 'utf8',
        env: process.env,
        timeout: 100,
        killGraceMs: 50,
        maxBuffer: 1024 * 1024,
      }),
      (error: any) => {
        assert.equal(error.killed, true)
        return true
      },
    )

    assert.ok(Date.now() - startedAt < 1_000, 'state export waited for a child that ignored SIGINT')
  },
)

test('reports state-export failures without exposing captured checkpoint data', async () => {
  const sensitiveValue = 'sentinel-state-secret'
  const failure = Object.assign(new Error('synthetic failure'), {
    code: 1,
    stdout: sensitiveValue,
    stderr: sensitiveValue,
  })

  await assert.rejects(
    readRunnerStateBaseline({
      stage: 'dev',
      sstArgs: ['diff', '--stage', 'dev'],
      async execute() {
        throw failure
      },
    }),
    (error: any) => {
      assert.match(error.message, /failed to export the current SST state: sst exited with status 1/)
      assert.doesNotMatch(error.message, new RegExp(sensitiveValue))
      return true
    },
  )
})
