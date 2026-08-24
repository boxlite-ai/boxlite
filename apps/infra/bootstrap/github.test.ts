// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  environmentApiPath,
  githubEnvironmentPayload,
  isProtectionUnavailableError,
  parseReviewerIds,
} from './github.js'

test('githubEnvironmentPayload requires the named reviewers as User entries', () => {
  assert.deepEqual(githubEnvironmentPayload({ reviewerIds: [583231] }), {
    reviewers: [{ type: 'User', id: 583231 }],
    deployment_branch_policy: null,
  })
})

test('githubEnvironmentPayload omits reviewers entirely when there are none', () => {
  // An empty `reviewers` array is handled inconsistently across plans; omitting
  // the key still creates the (unprotected) environment.
  const payload = githubEnvironmentPayload({ reviewerIds: [] })
  assert.equal('reviewers' in payload, false)
  assert.deepEqual(payload, { deployment_branch_policy: null })
})

test('githubEnvironmentPayload rejects logins where GitHub requires numeric ids', () => {
  assert.throws(() => githubEnvironmentPayload({ reviewerIds: ['dorianzheng'] }), /must be a positive integer/)
  assert.throws(() => githubEnvironmentPayload({ reviewerIds: [0] }), /must be a positive integer/)
  assert.throws(() => githubEnvironmentPayload({ reviewerIds: 583231 as any }), /must be an array/)
})

test('environmentApiPath targets the stage-named environment the trust policy pins', () => {
  assert.equal(environmentApiPath('boxlite-ai/boxlite', 'dev'), 'repos/boxlite-ai/boxlite/environments/dev')
  assert.equal(environmentApiPath('someone/fork', 'production'), 'repos/someone/fork/environments/production')
})

test('isProtectionUnavailableError recognizes the paid-plan rejection', () => {
  assert.equal(
    isProtectionUnavailableError('Environments are only available in public repositories for this account'),
    true,
  )
  assert.equal(isProtectionUnavailableError('You must upgrade to use deployment protection rules'), true)
})

test('isProtectionUnavailableError does not swallow a genuine failure', () => {
  assert.equal(isProtectionUnavailableError('HTTP 404: Not Found'), false)
  assert.equal(isProtectionUnavailableError('Bad credentials'), false)
  assert.equal(isProtectionUnavailableError(''), false)
  assert.equal(isProtectionUnavailableError(undefined), false)
})

test('parseReviewerIds accepts a comma-separated id list', () => {
  assert.deepEqual(parseReviewerIds('583231,99'), [583231, 99])
  assert.deepEqual(parseReviewerIds(' 583231 , 99 '), [583231, 99])
  assert.deepEqual(parseReviewerIds(''), [])
  assert.deepEqual(parseReviewerIds(undefined), [])
})

test('parseReviewerIds rejects a login so the failure is not deferred to the API', () => {
  assert.throws(() => parseReviewerIds('dorianzheng'), /numeric GitHub user ids/)
  assert.throws(() => parseReviewerIds('583231,dorianzheng'), /numeric GitHub user ids/)
})
