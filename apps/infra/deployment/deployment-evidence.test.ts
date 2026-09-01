// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentEvidenceEvents } from './deployment-evidence.js'

const input = {
  stage: 'dev',
  version: '0.10.0',
  commitSha: 'a'.repeat(40),
  components: ['api', 'runner'] as const,
  workflowName: 'deploy-infra' as const,
  runId: '123456789',
  runAttempt: 2,
  repository: 'boxlite-ai/boxlite',
  observedAt: '2026-08-30T02:00:00.000Z',
}

test('builds one bounded v1 event per deployed component with stable retry identities', () => {
  const first = deploymentEvidenceEvents(input)
  const retry = deploymentEvidenceEvents(input)

  assert.deepEqual(first, retry)
  assert.equal(first.length, 2)
  assert.notEqual(first[0]?.eventId, first[1]?.eventId)
  assert.match(first[0]?.eventId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(
    first.map(({ deployment }) => deployment.componentKey),
    ['api', 'runner'],
  )
  assert.equal(first[0]?.deployment.workflow.runAttempt, 2)
  assert.equal(first[0]?.deployment.workflow.url, 'https://github.com/boxlite-ai/boxlite/actions/runs/123456789')
})

test('a workflow rerun receives a new identity instead of conflicting with its earlier payload', () => {
  const first = deploymentEvidenceEvents(input)
  const rerun = deploymentEvidenceEvents({ ...input, runAttempt: 3 })

  assert.notEqual(first[0]?.eventId, rerun[0]?.eventId)
  assert.equal(rerun[0]?.deployment.workflow.runAttempt, 3)
})

test('rejects unsupported components and non-artifact commit identities', () => {
  assert.throws(() => deploymentEvidenceEvents({ ...input, components: ['database' as 'api'] }), /component/)
  assert.throws(() => deploymentEvidenceEvents({ ...input, commitSha: 'main' }), /commit/)
})
