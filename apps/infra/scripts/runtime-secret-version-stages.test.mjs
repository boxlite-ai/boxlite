// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUNTIME_SECRET_GENERATION_IDS,
  validateRuntimeSecretGenerations,
} from './deployment-config.mjs'
import { parseRuntimeSecretGenerations } from './runtime-secrets.mjs'
import { normalizeRuntimeSecretVersionStages } from './runtime-secret-version-stages.mjs'

const AWS_CONFORMANT_NON_UUID_VERSION_ID = '_'.repeat(32)
const AWS_CONFORMANT_GENERATIONS = Object.fromEntries(
  RUNTIME_SECRET_GENERATION_IDS.map((id) => [id, AWS_CONFORMANT_NON_UUID_VERSION_ID]),
)

test('accepts an AWS-conformant non-UUID VersionId from DescribeSecret metadata', () => {
  const versionStages = {
    [AWS_CONFORMANT_NON_UUID_VERSION_ID]: ['AWSCURRENT'],
  }

  assert.deepEqual(
    normalizeRuntimeSecretVersionStages({ VersionIdsToStages: versionStages }),
    versionStages,
  )
})

test('accepts an AWS-conformant non-UUID VersionId in a deployment release', () => {
  assert.deepEqual(
    validateRuntimeSecretGenerations(AWS_CONFORMANT_GENERATIONS),
    AWS_CONFORMANT_GENERATIONS,
  )
})

test('accepts an AWS-conformant non-UUID VersionId at the SST runtime boundary', () => {
  assert.deepEqual(
    parseRuntimeSecretGenerations(JSON.stringify(AWS_CONFORMANT_GENERATIONS)),
    AWS_CONFORMANT_GENERATIONS,
  )
})
