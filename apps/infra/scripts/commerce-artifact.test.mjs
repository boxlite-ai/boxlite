// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commerceImageReference, commerceImageRepository } from './commerce-artifact.mjs'

const ACCOUNT = '123456789012'
const REGION = 'ap-southeast-1'
const TAG = 'a94a80eac5e74376f07a8c7662e3a5b765ad2048'

test('spells the repository through the shared resource grammar', () => {
  assert.equal(commerceImageRepository({ app: 'boxlite', stage: 'dev' }), 'boxlite-app-dev-commerce')
})

test('composes the full private-registry reference', () => {
  assert.equal(
    commerceImageReference({ app: 'boxlite', stage: 'dev', accountId: ACCOUNT, region: REGION, tag: TAG }),
    `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/boxlite-app-dev-commerce:${TAG}`,
  )
})

test('a stage with no selected tag yields no reference, so the caller can omit the service', () => {
  for (const tag of [undefined, '']) {
    assert.equal(
      commerceImageReference({ app: 'boxlite', stage: 'staging', accountId: ACCOUNT, region: REGION, tag }),
      undefined,
    )
  }
})

test('refuses a tag ECR would reject, on the deployer rather than at pull time', () => {
  for (const tag of ['-leading-dash', 'has space', 'a'.repeat(129)]) {
    assert.throws(
      () => commerceImageReference({ app: 'boxlite', stage: 'dev', accountId: ACCOUNT, region: REGION, tag }),
      /not a valid ECR image tag/,
    )
  }
})

test('refuses a stage that cannot name a repository', () => {
  assert.throws(() => commerceImageRepository({ app: 'boxlite', stage: 'Dev_UPPER' }), /valid ECR repository name/)
})
