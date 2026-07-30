'use strict'

function parseRunId(value) {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`Invalid Build C SDK run ID: ${text}`)
  }

  const runId = Number(text)
  if (!Number.isSafeInteger(runId)) {
    throw new Error(`Build C SDK run ID is outside JavaScript's safe integer range: ${text}`)
  }
  return runId
}

function validateCSdkRun(run, expectedRepository, expectedWorkflowId) {
  if (run.workflow_id !== expectedWorkflowId) {
    throw new Error(`Run ${run.id} was not created by the repository's Build C SDK workflow`)
  }
  if (run.conclusion !== 'success') {
    throw new Error(`Build C SDK run ${run.id} did not succeed`)
  }
  if (run.head_repository?.full_name !== expectedRepository) {
    throw new Error(`Build C SDK run ${run.id} belongs to a different repository`)
  }
  if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? '')) {
    throw new Error(`Build C SDK run ${run.id} has an invalid head SHA`)
  }

  return {
    runId: String(run.id),
    headSha: run.head_sha,
  }
}

module.exports = { parseRunId, validateCSdkRun }
