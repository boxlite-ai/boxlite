'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { parseRunId, validateCSdkRun } = require('../ci/resolve-c-sdk-run.cjs')

const repository = 'boxlite-ai/boxlite'
const workflowId = 12345
const successfulRun = {
  id: 98765,
  workflow_id: workflowId,
  conclusion: 'success',
  head_repository: { full_name: repository },
  head_sha: 'a'.repeat(40),
}

test('parseRunId accepts a positive decimal workflow run ID', () => {
  assert.equal(parseRunId('30518801738'), 30518801738)
})

for (const invalid of ['', '0', '-1', '1e3', '12x', String(Number.MAX_SAFE_INTEGER + 1)]) {
  test(`parseRunId rejects ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => parseRunId(invalid), /run ID/i)
  })
}

test('validateCSdkRun returns provenance bound to the expected workflow', () => {
  assert.deepEqual(validateCSdkRun(successfulRun, repository, workflowId), {
    runId: '98765',
    headSha: 'a'.repeat(40),
  })
})

test('validateCSdkRun rejects a display-name spoof from another workflow', () => {
  assert.throws(
    () => validateCSdkRun({ ...successfulRun, workflow_id: workflowId + 1 }, repository, workflowId),
    /Build C SDK workflow/,
  )
})

test('validateCSdkRun rejects failed, foreign, and malformed runs', () => {
  assert.throws(
    () => validateCSdkRun({ ...successfulRun, conclusion: 'failure' }, repository, workflowId),
    /did not succeed/,
  )
  assert.throws(
    () =>
      validateCSdkRun(
        { ...successfulRun, head_repository: { full_name: 'fork/boxlite' } },
        repository,
        workflowId,
      ),
    /different repository/,
  )
  assert.throws(
    () => validateCSdkRun({ ...successfulRun, head_sha: 'not-a-sha' }, repository, workflowId),
    /invalid head SHA/,
  )
})
