// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const COMPONENTS = ['api', 'runner', 'proxy', 'otel-collector'] as const
type ComponentKey = (typeof COMPONENTS)[number]
type WorkflowName = 'deploy-infra' | 'deploy-release'

export type DeploymentEvidenceInput = {
  stage: string
  version: string
  commitSha: string
  components: readonly ComponentKey[]
  workflowName: WorkflowName
  runId: string
  runAttempt: number
  repository: string
  observedAt: string
}

export type DeploymentObservedV1 = {
  schemaVersion: 1
  eventType: 'deployment.observed'
  eventId: string
  source: 'boxlite-github-actions'
  occurredAt: string
  observedAt: string
  deployment: {
    componentKey: ComponentKey
    environment: string
    version: string
    commitSha: string
    state: 'succeeded'
    workflow: {
      repository: string
      name: WorkflowName
      runId: string
      runAttempt: number
      url: string
    }
  }
}

const bounded = (value: string, name: string, maximum: number): string => {
  const clean = value.trim()
  if (!clean || clean.length > maximum) throw new Error(`${name} must contain 1-${maximum} characters`)
  return clean
}

const deterministicEventId = (identity: string): string => {
  const bytes = createHash('sha256').update(identity, 'utf8').digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const deploymentEvidenceEvents = (input: DeploymentEvidenceInput): DeploymentObservedV1[] => {
  const stage = bounded(input.stage, 'stage', 64)
  const version = bounded(input.version, 'version', 128)
  const repository = bounded(input.repository, 'repository', 255)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be an owner/repository slug')
  }
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error('commitSha must be a lowercase full commit SHA')
  if (!/^[1-9]\d{0,63}$/.test(input.runId)) throw new Error('runId must be a positive GitHub run identifier')
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) {
    throw new Error('runAttempt must be a positive integer')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(input.observedAt)) {
    throw new Error('observedAt must be a UTC RFC 3339 timestamp')
  }
  if (input.components.length === 0 || new Set(input.components).size !== input.components.length) {
    throw new Error('components must contain unique deployed component identities')
  }
  for (const component of input.components) {
    if (!(COMPONENTS as readonly string[]).includes(component)) throw new Error(`unsupported component: ${component}`)
  }

  return input.components.map((componentKey) => ({
    schemaVersion: 1,
    eventType: 'deployment.observed',
    eventId: deterministicEventId(
      [repository, input.workflowName, input.runId, input.runAttempt, componentKey].join(':'),
    ),
    source: 'boxlite-github-actions',
    occurredAt: input.observedAt,
    observedAt: input.observedAt,
    deployment: {
      componentKey,
      environment: stage,
      version,
      commitSha: input.commitSha,
      state: 'succeeded',
      workflow: {
        repository,
        name: input.workflowName,
        runId: input.runId,
        runAttempt: input.runAttempt,
        url: `https://github.com/${repository}/actions/runs/${input.runId}`,
      },
    },
  }))
}

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to publish deployment evidence`)
  return value
}

/**
 * Why the send failed, in one line. The publish step is `continue-on-error`, so this is the
 * only trace a lost event leaves in the run: a bare attempt count cannot separate a denied
 * queue from an aws binary that never ran.
 */
const failureDetail = (result: SpawnSyncReturns<string>): string => {
  if (result.error) return `aws sqs send-message could not run: ${result.error.message}`
  const outcome = result.signal ? `killed by ${result.signal}` : `exited ${result.status}`
  const reason = result.stderr?.trim().replace(/\s+/g, ' ').slice(0, 300)
  return reason ? `aws sqs send-message ${outcome}: ${reason}` : `aws sqs send-message ${outcome}`
}

const publish = (queueUrl: string, event: DeploymentObservedV1): void => {
  let lastFailure = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      'aws',
      ['sqs', 'send-message', '--queue-url', queueUrl, '--message-body', JSON.stringify(event), '--output', 'json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    if (result.status === 0) return
    lastFailure = failureDetail(result)
  }
  throw new Error(
    `deployment evidence send failed for component ${event.deployment.componentKey} ` +
      `(event ${event.eventId}) after 3 attempts: ${lastFailure}`,
  )
}

export const publishFromEnvironment = (): void => {
  const queueUrl = new URL(required('BACKOFFICE_DEPLOYMENT_QUEUE_URL'))
  if (queueUrl.protocol !== 'https:' || queueUrl.username || queueUrl.password || queueUrl.hash) {
    throw new Error('BACKOFFICE_DEPLOYMENT_QUEUE_URL must be a credential-free HTTPS URL')
  }
  const components = required('DEPLOYMENT_EVIDENCE_COMPONENTS').split(',') as ComponentKey[]
  const runAttempt = Number(required('GITHUB_RUN_ATTEMPT'))
  const events = deploymentEvidenceEvents({
    stage: required('STAGE'),
    version: required('DEPLOYMENT_EVIDENCE_VERSION'),
    commitSha: required('DEPLOYMENT_EVIDENCE_COMMIT_SHA'),
    components,
    workflowName: required('DEPLOYMENT_EVIDENCE_WORKFLOW') as WorkflowName,
    runId: required('GITHUB_RUN_ID'),
    runAttempt,
    repository: required('GITHUB_REPOSITORY'),
    observedAt: new Date().toISOString(),
  })
  for (const event of events) publish(queueUrl.href, event)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    publishFromEnvironment()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'deployment evidence publication failed')
    process.exitCode = 1
  }
}
