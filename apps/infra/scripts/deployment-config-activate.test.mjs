// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { activateDeploymentConfig } from './deployment-config-activate.mjs'

const RELEASE_ID = 'a'.repeat(64)
const REBASED_RELEASE_ID = 'b'.repeat(64)
const EXPECTED_GENERATIONS = Object.freeze({ synthetic: 'not-inspected-by-this-boundary-test' })
const CURRENT_GENERATIONS = Object.freeze({ synthetic: 'current-generation-metadata' })

function fixture({ guardFailure } = {}) {
  const events = []
  const release = {
    releaseId: RELEASE_ID,
    document: { values: { BOXLITE_RUNTIME_SECRET_GENERATIONS: EXPECTED_GENERATIONS } },
  }
  const store = {
    async withDeploymentOperationLock(options, callback) {
      events.push(['lock-enter', options])
      try {
        return await callback()
      } finally {
        events.push(['lock-exit'])
      }
    },
    resolve(options) {
      events.push(['resolve', options])
      return release
    },
    activate(options) {
      events.push(['activate', options])
      return { ...release, releaseId: options.releaseId, isCurrent: true }
    },
    prepareDocument(options) {
      events.push(['prepare-document', options])
      return { releaseId: REBASED_RELEASE_ID, document: options.document }
    },
  }
  const dependencies = {
    resolveAwsCli() {
      return '/synthetic/aws'
    },
    createStore(options) {
      events.push(['create-store', options])
      return store
    },
    assertGenerations(options) {
      events.push(['guard', options])
      if (guardFailure) throw guardFailure
    },
    readGenerations(options) {
      events.push(['read-generations', options])
      return CURRENT_GENERATIONS
    },
    log(message) {
      events.push(['log', message])
    },
  }
  return { dependencies, events, release }
}

test('config activation validates runtime generations while holding the operation lock', async () => {
  const { dependencies, events } = fixture()
  const result = await activateDeploymentConfig(
    ['--stage', 'dev', '--release', RELEASE_ID],
    { AWS_CLI_PATH: '/synthetic/aws', AWS_REGION: 'ap-southeast-1' },
    dependencies,
  )

  assert.equal(result.isCurrent, true)
  assert.deepEqual(
    events.map(([event]) => event),
    ['create-store', 'lock-enter', 'resolve', 'guard', 'activate', 'lock-exit', 'log'],
  )
  assert.equal(events.find(([event]) => event === 'guard')[1].expectedGenerations, EXPECTED_GENERATIONS)
})

test('config activation leaves current untouched when the selected release has stale generations', async () => {
  const guardFailure = new Error('runtime secret generations do not match the pinned deployment config')
  const { dependencies, events } = fixture({ guardFailure })

  await assert.rejects(
    activateDeploymentConfig(
      ['--stage', 'dev', '--release', RELEASE_ID],
      { AWS_CLI_PATH: '/synthetic/aws', AWS_REGION: 'ap-southeast-1' },
      dependencies,
    ),
    /--rebase-runtime-generations/,
  )
  assert.deepEqual(events.map(([event]) => event), ['create-store', 'lock-enter', 'resolve', 'guard', 'lock-exit'])
})

test('explicit generation rebase creates and activates a new release without mutating the source document', async () => {
  const { dependencies, events, release } = fixture()
  const sourceGenerations = release.document.values.BOXLITE_RUNTIME_SECRET_GENERATIONS
  const result = await activateDeploymentConfig(
    ['--stage', 'dev', '--release', RELEASE_ID, '--rebase-runtime-generations'],
    { AWS_CLI_PATH: '/synthetic/aws', AWS_REGION: 'ap-southeast-1' },
    dependencies,
  )

  assert.equal(result.sourceReleaseId, RELEASE_ID)
  assert.equal(result.releaseId, REBASED_RELEASE_ID)
  assert.deepEqual(
    events.map(([event]) => event),
    ['create-store', 'lock-enter', 'resolve', 'read-generations', 'prepare-document', 'activate', 'lock-exit', 'log'],
  )
  const preparedDocument = events.find(([event]) => event === 'prepare-document')[1].document
  assert.equal(preparedDocument.values.BOXLITE_RUNTIME_SECRET_GENERATIONS, CURRENT_GENERATIONS)
  assert.equal(release.document.values.BOXLITE_RUNTIME_SECRET_GENERATIONS, sourceGenerations)
  const selectedDocument = events.find(([event]) => event === 'resolve')[1]
  assert.deepEqual(selectedDocument, { stage: 'dev', releaseId: RELEASE_ID })
  const logMessage = events.find(([event]) => event === 'log')[1]
  assert.match(logMessage, new RegExp(`${RELEASE_ID}.*${REBASED_RELEASE_ID}`))
})
