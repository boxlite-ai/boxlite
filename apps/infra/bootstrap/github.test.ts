// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('every cloud identity is written to one stage, never shared across the repository', () => {
  /*
   * A per-project account in a repository-wide variable belongs to whichever
   * stage bootstrapped last. `GCP_IMAGE_PUBLISHER` was exempted on the grounds
   * that its reader declares no environment; `mbuild.yml`'s publish job
   * declares `environment: ${{ inputs.stage || inputs.to }}` and is the only
   * reader, so the exemption rested on nothing. Bootstrapping prod pointed
   * dev's publish at `bl-app-publish@boxlite-prod-project`, which the dev pool
   * cannot impersonate — three denied attempts, after every image was built.
   *
   * Read out of the source because the call is a `gh` subprocess: what has to
   * hold is that none of these names is ever handed a null stage, and that is
   * a property of the call site.
   */
  const source = readFileSync(fileURLToPath(new URL('./bootstrap.ts', import.meta.url)), 'utf8')
  const shared = [...source.matchAll(/ghEnvironmentVariableSet\(\{[^}]*\}\)/g)]
    .map((match) => match[0])
    .filter((call) => /stage: null/.test(call))
    .filter((call) => /name: '(GCP|AWS)_[A-Z_]+'/.test(call))
  assert.deepEqual(shared, [], 'a cloud identity written repository-wide belongs to whoever bootstrapped last')
})
