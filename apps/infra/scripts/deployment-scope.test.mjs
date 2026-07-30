// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { requireFullStackDeploy, requireSstSubcommandFirst, withRequiredRunnerPolicy } from './deployment-scope.mjs'

const RUNNER_POLICY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('always injects the repository Runner policy root', () => {
  assert.deepEqual(withRequiredRunnerPolicy(['deploy', '--stage', 'dev'], '/untrusted/working-directory'), [
    'deploy',
    '--stage',
    'dev',
    '--policy',
    RUNNER_POLICY_ROOT,
  ])
})

test('rejects flag-first SST syntax so deployment guards cannot be bypassed', () => {
  assert.doesNotThrow(() => requireSstSubcommandFirst(['deploy', '--stage', 'dev']))
  assert.throws(
    () => requireSstSubcommandFirst(['--stage', 'dev', 'deploy', '--target', 'Api']),
    /subcommand must be the first argument/,
  )
  assert.throws(() => requireSstSubcommandFirst(['dev']), /sst dev is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['dev', '--', 'next', 'dev']), /sst dev is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['diff', '--stage', 'dev', '--']), /argument delimiter is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['deploy', '--', '--policy', '.']), /argument delimiter is disabled/)
})

test('accepts full-stack deploys and read-only targeted diffs', () => {
  assert.doesNotThrow(() => requireFullStackDeploy(['deploy', '--stage', 'dev']))
  assert.doesNotThrow(() => requireFullStackDeploy(['diff', '--stage', 'dev', '--target', 'Api']))
})

test('rejects every partial deploy selector form before SST runs', () => {
  for (const args of [
    ['deploy', '--stage', 'dev', '--target', 'Api'],
    ['deploy', '--stage', 'dev', '--target=Api'],
    ['deploy', '--stage', 'dev', '--exclude', 'Runner'],
    ['deploy', '--stage', 'dev', '--exclude=Runner'],
  ]) {
    assert.throws(() => requireFullStackDeploy(args), /partial SST deploys are disabled/)
  }
})

test('requires the repository Runner policy for every preview and deploy', () => {
  assert.deepEqual(withRequiredRunnerPolicy(['diff', '--stage', 'dev'], RUNNER_POLICY_ROOT), [
    'diff',
    '--stage',
    'dev',
    '--policy',
    RUNNER_POLICY_ROOT,
  ])
  assert.deepEqual(withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy=.'], RUNNER_POLICY_ROOT), [
    'deploy',
    '--stage',
    'dev',
    `--policy=${RUNNER_POLICY_ROOT}`,
  ])
  assert.deepEqual(withRequiredRunnerPolicy(['state', 'export', '--stage', 'dev'], RUNNER_POLICY_ROOT), [
    'state',
    'export',
    '--stage',
    'dev',
  ])

  assert.throws(
    () => withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy', '../other-policy'], RUNNER_POLICY_ROOT),
    /Runner policy.*must be/,
  )
  assert.throws(
    () => withRequiredRunnerPolicy(['diff', '--policy', '.', '--policy=.'], RUNNER_POLICY_ROOT),
    /Runner policy.*exactly once/,
  )

  for (const args of [
    ['diff', '--policy'],
    ['diff', '--policy='],
    ['deploy', '--policy', '.', '--policy', '.'],
  ]) {
    assert.throws(() => withRequiredRunnerPolicy(args, RUNNER_POLICY_ROOT), /Runner policy/)
  }
})

test('resolves relative Runner policy paths from the supplied working directory', () => {
  const workingDirectory = resolve(RUNNER_POLICY_ROOT, 'scripts')

  assert.deepEqual(withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy', '..'], workingDirectory), [
    'deploy',
    '--stage',
    'dev',
    '--policy',
    RUNNER_POLICY_ROOT,
  ])
})
