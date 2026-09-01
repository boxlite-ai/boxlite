// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { deploymentEvidenceEvents, publishFromEnvironment } from './deployment-evidence.js'

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

// Stands in for the AWS CLI so the retry loop can be driven without a queue. It records the
// message body of every invocation and fails the way a rejected send does: a non-zero exit
// with the reason on stderr.
const withFailingAwsCli = (run: (sentBodies: () => string[]) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-evidence-'))
  const record = join(directory, 'sent.jsonl')
  const shim = join(directory, 'aws')
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$6" >> "${record}"\n` +
      `echo 'An error occurred (AccessDenied) when calling the SendMessage operation' >&2\nexit 254\n`,
  )
  chmodSync(shim, 0o755)
  const environment = { ...process.env }
  Object.assign(process.env, {
    PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
    BACKOFFICE_DEPLOYMENT_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/111122223333/backoffice-deployments',
    DEPLOYMENT_EVIDENCE_COMPONENTS: 'api',
    DEPLOYMENT_EVIDENCE_VERSION: input.version,
    DEPLOYMENT_EVIDENCE_COMMIT_SHA: input.commitSha,
    DEPLOYMENT_EVIDENCE_WORKFLOW: input.workflowName,
    STAGE: input.stage,
    GITHUB_RUN_ID: input.runId,
    GITHUB_RUN_ATTEMPT: String(input.runAttempt),
    GITHUB_REPOSITORY: input.repository,
  })
  try {
    run(() => readFileSync(record, 'utf8').split('\n').filter(Boolean))
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
    rmSync(directory, { recursive: true, force: true })
  }
}

// The publish step is `continue-on-error`, so the thrown message is the only trace a lost
// send leaves in the run. Reporting just the attempt count cannot tell a denied queue from
// an aws binary that is not on PATH.
test('a send that keeps failing reports what the CLI said', () => {
  withFailingAwsCli((sentBodies) => {
    assert.throws(publishFromEnvironment, (error: Error) => {
      assert.match(error.message, /api/)
      assert.match(error.message, /254/)
      assert.match(error.message, /AccessDenied/)
      return true
    })
    // The retry exists because a send can fail after SQS already accepted it, so every
    // attempt has to carry the identity the consumer de-duplicates on.
    const bodies = sentBodies()
    assert.equal(bodies.length, 3)
    assert.equal(new Set(bodies).size, 1)
    assert.equal(JSON.parse(bodies[0] ?? '{}').eventId, deploymentEvidenceEvents(input)[0]?.eventId)
  })
})
