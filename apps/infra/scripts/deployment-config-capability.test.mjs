// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { verifyDeploymentConfigCapability } from './deployment-config-capability.mjs'

test('selected-ref capability probe exercises the composed loader without AWS credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/deployment-config-capability.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI_PATH: '/synthetic/aws-must-not-run',
      AWS_ACCESS_KEY_ID: 'must-not-be-read',
      AWS_SECRET_ACCESS_KEY: 'must-not-be-read',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'deployment-config-capability: supported\n')
  assert.equal(result.stderr, '')
})

test('selected-ref capability permits lock-only store use but rejects direct config resolution', () => {
  const wrapperSource = readFileSync(new URL('sst-with-cloudflare.mjs', import.meta.url), 'utf8')
  assert.equal(verifyDeploymentConfigCapability({ wrapperSource }), true)
  assert.throws(
    () =>
      verifyDeploymentConfigCapability({
        wrapperSource: `${wrapperSource}\ndeploymentOperationLockStore.resolve({ stage })`,
      }),
    /bypasses the composed deployment config loader/,
  )
})
