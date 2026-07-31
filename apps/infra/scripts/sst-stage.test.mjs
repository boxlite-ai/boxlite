// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { requireIamPermissionsBoundaryStage, resolveSstStage } from './sst-stage.mjs'

test('resolves a stage from separate and inline CLI arguments', () => {
  assert.equal(resolveSstStage(['deploy', '--stage', 'dev'], {}), 'dev')
  assert.equal(resolveSstStage(['deploy', '--stage=production'], {}), 'production')
})

test('resolves an explicitly configured SST_STAGE', () => {
  assert.equal(resolveSstStage(['deploy'], { SST_STAGE: 'staging' }), 'staging')
})

test('rejects duplicate stage options instead of guessing which one SST will use', () => {
  assert.throws(
    () => resolveSstStage(['deploy', '--stage', 'dev', '--stage=production'], {}),
    /--stage may be specified only once/,
  )
})

test('rejects unsafe CLI and environment stage values', () => {
  for (const stage of ['dev/production', ' dev', 'dev ', '--production', '']) {
    if (stage === '') {
      assert.throws(() => resolveSstStage(['deploy', '--stage='], {}), /--stage requires a value/)
      continue
    }
    assert.throws(() => resolveSstStage(['deploy', `--stage=${stage}`], {}), /invalid SST stage/)
  }

  assert.throws(() => resolveSstStage(['deploy'], { SST_STAGE: 'dev/production' }), /invalid SST stage/)
  assert.equal(resolveSstStage(['deploy', '--stage', 'feature_42-test'], {}), 'feature_42-test')
})

test('requires an explicit stage for state-changing stack commands', () => {
  assert.throws(() => resolveSstStage(['deploy'], {}), /deploy requires an explicit --stage or SST_STAGE/)
  assert.throws(() => resolveSstStage(['remove'], {}), /remove requires an explicit --stage or SST_STAGE/)
})

test('retains the dev credential lookup default for non-deploy commands', () => {
  assert.equal(resolveSstStage(['diff'], {}), 'dev')
})

test('requires the provisioned IAM boundary stage to match the SST stage', () => {
  assert.equal(requireIamPermissionsBoundaryStage('dev', { IAM_PERMISSIONS_BOUNDARY_STAGE: 'dev' }), 'dev')
  assert.throws(
    () => requireIamPermissionsBoundaryStage('production', { IAM_PERMISSIONS_BOUNDARY_STAGE: 'dev' }),
    /IAM permissions boundary stage dev does not match SST stage production/,
  )
  assert.throws(() => requireIamPermissionsBoundaryStage('dev', {}), /IAM_PERMISSIONS_BOUNDARY_STAGE is required/)
})
