// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { runDeploymentConfigResolve } from './deployment-config-resolve.mjs'

const RELEASE = 'a'.repeat(64)

function resolveFixture(args) {
  const calls = []
  let stdout = ''
  const result = runDeploymentConfigResolve(args, {
    environment: { AWS_CLI_PATH: process.execPath, AWS_REGION: 'ap-southeast-1' },
    createStore(options) {
      calls.push({ operation: 'create', options })
      return {
        resolve(selection) {
          calls.push({ operation: 'resolve', selection })
          return { releaseId: RELEASE, document: {} }
        },
      }
    },
    output: { write(chunk) { stdout += chunk } },
  })
  return { calls, result, stdout }
}

test('prints only the one validated deployment config digest for workflow capture', () => {
  const current = resolveFixture(['--stage', 'dev'])
  assert.equal(current.stdout, `${RELEASE}\n`)
  assert.equal(current.result.releaseId, RELEASE)
  assert.deepEqual(current.calls, [
    { operation: 'create', options: { awsCliPath: process.execPath, region: 'ap-southeast-1' } },
    { operation: 'resolve', selection: { stage: 'dev', releaseId: undefined } },
  ])

  const pinned = resolveFixture(['--stage=dev', `--release=${RELEASE}`])
  assert.equal(pinned.stdout, `${RELEASE}\n`)
  assert.deepEqual(pinned.calls[1], {
    operation: 'resolve',
    selection: { stage: 'dev', releaseId: RELEASE },
  })
})

test('rejects incomplete, duplicate, unknown, or malformed resolver inputs before AWS', () => {
  const options = {
    environment: { AWS_CLI_PATH: '/fake/aws', AWS_REGION: 'ap-southeast-1' },
    createStore() {
      assert.fail('invalid resolver input must not construct an AWS store')
    },
    output: { write() { assert.fail('invalid resolver input must not write stdout') } },
  }

  assert.throws(() => runDeploymentConfigResolve([], options), /--stage is required/)
  assert.throws(() => runDeploymentConfigResolve(['--stage', 'dev', '--stage=prod'], options), /only once/)
  assert.throws(() => runDeploymentConfigResolve(['--stage', '../prod'], options), /invalid deployment config stage/)
  assert.throws(() => runDeploymentConfigResolve(['--stage', 'dev', '--release', 'latest'], options), /SHA-256/)
  assert.throws(() => runDeploymentConfigResolve(['--stage', 'dev', '--unknown'], options), /unknown argument/)
})
