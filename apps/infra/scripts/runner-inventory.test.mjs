// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import runnerInventory from './runner-inventory.cjs'

const { extraRunnerInstanceProfileName, resolveRunnerInventory } = runnerInventory

test('derives one exact stage-bound extra Runner profile name', () => {
  assert.equal(extraRunnerInstanceProfileName('dev'), 'boxlite-dev-extra-runner-profile')
  for (const stage of ['', '../prod', 'Dev', 'dev_test', 'dev-blue', 'x'.repeat(21)]) {
    assert.throws(() => extraRunnerInstanceProfileName(stage), /invalid SST stage/)
  }
})

test('resolves the exact default and extra Runner identities from deployment config', () => {
  assert.deepEqual(resolveRunnerInventory({}), [
    {
      resourceName: 'Runner',
      nameTag: 'boxlite-runner-default',
      controlPlaneRunnerName: 'default',
    },
  ])
  assert.deepEqual(resolveRunnerInventory({ RUNNERS: '3', DEFAULT_RUNNER_NAME: 'primary' }), [
    {
      resourceName: 'Runner',
      nameTag: 'boxlite-runner-default',
      controlPlaneRunnerName: 'primary',
    },
    {
      resourceName: 'Runner-runner-2',
      nameTag: 'boxlite-runner-2',
      controlPlaneRunnerName: 'runner-2',
    },
    {
      resourceName: 'Runner-runner-3',
      nameTag: 'boxlite-runner-3',
      controlPlaneRunnerName: 'runner-3',
    },
  ])
})

test('rejects malformed or unsafe Runner counts at the deployment boundary', () => {
  assert.equal(resolveRunnerInventory({ RUNNERS: '' }).length, 1)
  assert.equal(resolveRunnerInventory({ RUNNERS: '100' }).length, 100)

  for (const runners of ['0', '-2', '3-extra', '1.5', ' 3', '101']) {
    assert.throws(() => resolveRunnerInventory({ RUNNERS: runners }), /RUNNERS must be an integer between 1 and 100/)
  }
})

test('rejects invalid or duplicate control-plane Runner identities', () => {
  for (const defaultRunnerName of ['a', 'runner name', 'x'.repeat(256)]) {
    assert.throws(
      () => resolveRunnerInventory({ DEFAULT_RUNNER_NAME: defaultRunnerName }),
      /DEFAULT_RUNNER_NAME must be/,
    )
  }

  assert.throws(
    () => resolveRunnerInventory({ RUNNERS: '2', DEFAULT_RUNNER_NAME: 'runner-2' }),
    /Runner names must be unique/,
  )
})
