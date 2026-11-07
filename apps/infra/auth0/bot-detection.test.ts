// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { runBotDetectionCommand } from './bot-detection-command.js'
import { Auth0ManagementCli } from './management-cli.js'
import targets from './targets.json' with { type: 'json' }
import type { JsonObject } from './universal-login.js'

const RESOURCE = 'attack-protection/bot-detection'
const DEV_FLAGS = ['--tenant', targets.dev.auth0TenantDomain, '--no-input', '--no-color']
const BASELINE = {
  challenge_password_policy: 'never',
  monitoring_mode_enabled: false,
  challenge_password_reset_policy: 'always',
}

function fixture(
  initial: JsonObject = BASELINE,
  applyPatch: (state: JsonObject, patch: JsonObject) => void = (state, patch) => Object.assign(state, patch),
) {
  const state = { ...initial }
  const calls: string[][] = []
  const output: string[] = []
  const management = new Auth0ManagementCli({
    execute: async (args) => {
      calls.push(args)
      if (args[1] === 'patch') applyPatch(state, JSON.parse(args[4]))
      return { ...state }
    },
  })
  return {
    calls,
    output,
    run: (...args: string[]) => runBotDetectionCommand(args, management, (line) => output.push(line)),
  }
}

test('preview reads the selected tenant and shows the current and desired policies', async () => {
  const { calls, output, run } = fixture()
  await run('preview', '--stage', 'dev')
  assert.deepEqual(calls, [['api', 'get', RESOURCE, ...DEV_FLAGS]])
  assert.ok(output.some((line) => line.includes(targets.dev.auth0TenantDomain)))
  assert.ok(output.some((line) => line.includes('never -> when_risky')))
})

test('apply patches only the password policy, verifies it, and skips a second patch', async () => {
  const { calls, output, run } = fixture()
  await run('apply', '--stage', 'dev')
  await run('apply', '--stage', 'dev')
  assert.deepEqual(calls, [
    ['api', 'get', RESOURCE, ...DEV_FLAGS],
    ['api', 'patch', RESOURCE, '--data', '{"challenge_password_policy":"when_risky"}', ...DEV_FLAGS],
    ['api', 'get', RESOURCE, ...DEV_FLAGS],
    ['api', 'get', RESOURCE, ...DEV_FLAGS],
  ])
  assert.ok(output.includes('Verified Auth0 password challenge policy: when_risky'))
  assert.ok(output.includes('Password challenge policy already matches.'))
})

test('production preview and apply use the production tenant', async () => {
  const { calls, run } = fixture()
  const flags = ['--tenant', targets.prod.auth0TenantDomain, '--no-input', '--no-color']
  const read = ['api', 'get', RESOURCE, ...flags]
  await run('preview', '--stage', 'prod')
  assert.deepEqual(calls, [read])

  await run('apply', '--stage', 'prod')
  assert.deepEqual(calls, [
    read,
    read,
    ['api', 'patch', RESOURCE, '--data', '{"challenge_password_policy":"when_risky"}', ...flags],
    read,
  ])
})

test('missing and unknown stages fail before calling Auth0', async () => {
  const { calls, run } = fixture()
  await assert.rejects(run('apply'), /--stage is required/)
  await assert.rejects(run('apply', '--stage', 'other'), /not configured/)
  assert.deepEqual(calls, [])
})

test('malformed state and a denied read stop before PATCH', async () => {
  const { calls, run } = fixture({ ...BASELINE, monitoring_mode_enabled: 'false' })
  await assert.rejects(run('apply', '--stage', 'dev'), /invalid password challenge policy or monitoring flag/)
  assert.deepEqual(calls, [['api', 'get', RESOURCE, ...DEV_FLAGS]])

  const denied = new Auth0ManagementCli({
    execute: async (args) => {
      assert.equal(args[1], 'get')
      throw new Error('403 denied')
    },
  })
  await assert.rejects(runBotDetectionCommand(['apply', '--stage', 'dev'], denied, () => {}), /403 denied/)
})

test('apply rejects monitoring mode before either PATCH or a matching-policy success', async () => {
  for (const policy of ['never', 'when_risky']) {
    const { calls, run } = fixture({ ...BASELINE, challenge_password_policy: policy, monitoring_mode_enabled: true })
    await assert.rejects(run('apply', '--stage', 'dev'), /monitoring mode/)
    assert.deepEqual(calls, [['api', 'get', RESOURCE, ...DEV_FLAGS]])
  }
})

test('apply fails when readback has the wrong policy or monitoring turns on', async () => {
  const ignored = fixture(BASELINE, () => {})
  await assert.rejects(ignored.run('apply', '--stage', 'dev'), /readback returned policy never/)

  const monitoring = fixture(BASELINE, (state, patch) => Object.assign(state, patch, { monitoring_mode_enabled: true }))
  await assert.rejects(monitoring.run('apply', '--stage', 'dev'), /policy when_risky and monitoring mode true/)
  assert.deepEqual(monitoring.calls.map((args) => args[1]), ['get', 'patch', 'get'])
})

test('apply surfaces a denied PATCH without retrying it', async () => {
  const { calls, run } = fixture(BASELINE, () => {
    throw new Error('403 denied')
  })
  await assert.rejects(run('apply', '--stage', 'dev'), /Preview stage 'dev' before retrying.*403 denied/)
  assert.deepEqual(calls.map((args) => args[1]), ['get', 'patch'])
})

test('a second apply recovers from a lost PATCH response without repeating the write', async () => {
  const { calls, run } = fixture(BASELINE, (state, patch) => {
    Object.assign(state, patch)
    throw new Error('response lost')
  })
  await assert.rejects(run('apply', '--stage', 'dev'), /Preview stage 'dev' before retrying.*response lost/)
  await run('apply', '--stage', 'dev')
  assert.deepEqual(calls.map((args) => args[1]), ['get', 'patch', 'get'])
})
