// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { runAwsJson } from './proxy-deployment-verify.mjs'

export const BILLING_OUTBOX_MIGRATION_ID = '1786000500000-outbox-cutover-complete'
export const BILLING_OUTBOX_SERVICE_NAME = 'Api'
export const BILLING_OUTBOX_SCALABLE_DIMENSION = 'ecs:service:DesiredCount'

function requireValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function requireStage(stage) {
  const value = requireValue(stage, 'SST stage')
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`SST stage contains unsupported characters: ${value}`)
  }
  return value
}

function exactlyOne(values, label) {
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error(`${label}: expected exactly one, found ${values?.length ?? 0}`)
  }
  return values[0]
}

function ecsClusterName(clusterArn) {
  const match = /^arn:[^:]+:ecs:[^:]+:[0-9]{12}:cluster\/([A-Za-z0-9_-]{1,255})$/.exec(clusterArn)
  if (!match) throw new Error('SST-tagged ECS cluster returned a malformed ARN')
  return match[1]
}

function errorText(error) {
  const parts = []
  let current = error
  while (current && !parts.includes(current)) {
    parts.push(current)
    current = current.cause
  }
  return parts
    .flatMap((candidate) => [candidate?.name, candidate?.message, candidate?.stderr?.toString()])
    .filter(Boolean)
    .join('\n')
}

export function isParameterNotFound(error) {
  return /(?:^|[^A-Za-z])ParameterNotFound(?:[^A-Za-z]|$)/.test(errorText(error))
}

export function billingOutboxCutoverMarkerName(stage) {
  return `/boxlite/${requireStage(stage)}/migrations/${BILLING_OUTBOX_MIGRATION_ID}`
}

function awsQuery(region, awsJson) {
  const resolvedRegion = requireValue(region, 'AWS region')
  return awsJson ?? ((args) => runAwsJson(args, resolvedRegion))
}

export function readBillingOutboxCutoverMarker({ stage, region, awsJson }) {
  const markerName = billingOutboxCutoverMarkerName(stage)
  const queryAws = awsQuery(region, awsJson)
  let response

  try {
    response = queryAws(['ssm', 'get-parameter', '--name', markerName])
  } catch (error) {
    if (isParameterNotFound(error)) return { markerName, present: false }
    throw error
  }

  const parameter = response?.Parameter
  if (!parameter) throw new Error(`SSM returned no parameter for billing outbox cutover marker ${markerName}`)
  if (parameter.Name !== undefined && parameter.Name !== markerName) {
    throw new Error(`SSM returned the wrong billing outbox cutover marker name`)
  }
  if (parameter.Type !== 'String') {
    throw new Error(`Billing outbox cutover marker ${markerName} must be an SSM String`)
  }
  if (typeof parameter.Value !== 'string' || !parameter.Value.trim()) {
    throw new Error(`Billing outbox cutover marker ${markerName} is empty`)
  }

  // The marker value is deliberately not returned: callers only need the
  // completed/not-completed decision and must never echo parameter contents.
  return { markerName, present: true }
}

export function assertApiServiceIsDrained({ app = 'boxlite', stage, region, awsJson }) {
  const resolvedApp = requireValue(app, 'SST app')
  const resolvedStage = requireStage(stage)
  const queryAws = awsQuery(region, awsJson)

  const taggedClusters = queryAws([
    'resourcegroupstaggingapi',
    'get-resources',
    '--resource-type-filters',
    'ecs:cluster',
    '--tag-filters',
    `Key=sst:app,Values=${resolvedApp}`,
    `Key=sst:stage,Values=${resolvedStage}`,
  ])
  const clusterArn = exactlyOne(
    taggedClusters.ResourceTagMappingList?.map((resource) => resource.ResourceARN).filter(Boolean),
    `ECS cluster tagged sst:app=${resolvedApp}, sst:stage=${resolvedStage}`,
  )

  const describedServices = queryAws([
    'ecs',
    'describe-services',
    '--cluster',
    clusterArn,
    '--services',
    BILLING_OUTBOX_SERVICE_NAME,
  ])
  if (!Array.isArray(describedServices.failures)) {
    throw new Error('Api ECS service lookup returned no failures inventory')
  }
  if (describedServices.failures.length > 0) {
    throw new Error(`Api ECS service lookup reported ${describedServices.failures.length} failure(s)`)
  }
  const service = exactlyOne(describedServices.services, 'Api ECS service')
  if (service.serviceName !== BILLING_OUTBOX_SERVICE_NAME) {
    throw new Error(`Api ECS service inventory returned serviceName ${service.serviceName ?? 'missing'}`)
  }

  const counts = {}
  for (const field of ['desiredCount', 'runningCount', 'pendingCount']) {
    if (!Number.isInteger(service[field]) || service[field] < 0) {
      throw new Error(`Api ECS service ${field} is ${service[field] ?? 'missing'}, expected a non-negative integer`)
    }
    counts[field] = service[field]
  }

  // Scaling the service to zero is not durable while the target's floor is
  // still one: Application Auto Scaling can restore the old revision after
  // this snapshot but before SST installs the outbox-aware task definition.
  const scalableTargetResourceId = `service/${ecsClusterName(clusterArn)}/${BILLING_OUTBOX_SERVICE_NAME}`
  const describedScalableTargets = queryAws([
    'application-autoscaling',
    'describe-scalable-targets',
    '--service-namespace',
    'ecs',
    '--resource-ids',
    scalableTargetResourceId,
    '--scalable-dimension',
    BILLING_OUTBOX_SCALABLE_DIMENSION,
  ])
  if (!Array.isArray(describedScalableTargets.ScalableTargets)) {
    throw new Error('Api Application Auto Scaling lookup returned no scalable-target inventory')
  }
  const scalableTarget = exactlyOne(
    describedScalableTargets.ScalableTargets,
    'Api ecs:service:DesiredCount scalable target',
  )
  if (scalableTarget.ResourceId !== scalableTargetResourceId) {
    throw new Error(
      `Api scalable target ResourceId is ${scalableTarget.ResourceId ?? 'missing'}, ` +
        `expected ${scalableTargetResourceId}`,
    )
  }
  if (scalableTarget.ServiceNamespace !== 'ecs') {
    throw new Error(`Api scalable target ServiceNamespace is ${scalableTarget.ServiceNamespace ?? 'missing'}`)
  }
  if (scalableTarget.ScalableDimension !== BILLING_OUTBOX_SCALABLE_DIMENSION) {
    throw new Error(`Api scalable target ScalableDimension is ${scalableTarget.ScalableDimension ?? 'missing'}`)
  }
  for (const field of ['MinCapacity', 'MaxCapacity']) {
    if (!Number.isInteger(scalableTarget[field]) || scalableTarget[field] < 0) {
      throw new Error(
        `Api ecs:service:DesiredCount ${field} is ${scalableTarget[field] ?? 'missing'}, ` +
          `expected a non-negative integer`,
      )
    }
  }
  if (scalableTarget.MaxCapacity < scalableTarget.MinCapacity) {
    throw new Error('Api ecs:service:DesiredCount MaxCapacity is below MinCapacity')
  }
  if (scalableTarget.MinCapacity !== 0) {
    throw new Error(
      `Api ecs:service:DesiredCount MinCapacity is ${scalableTarget.MinCapacity}; ` +
        `set it to 0 before the first billing outbox deploy`,
    )
  }

  const tasksByStatus = {}
  for (const status of ['RUNNING', 'PENDING']) {
    const listedTasks = queryAws([
      'ecs',
      'list-tasks',
      '--cluster',
      clusterArn,
      '--service-name',
      BILLING_OUTBOX_SERVICE_NAME,
      '--desired-status',
      status,
    ])
    if (!Array.isArray(listedTasks.taskArns)) {
      throw new Error(`Api ECS ${status} task lookup returned no task inventory`)
    }
    tasksByStatus[status] = listedTasks.taskArns.length
  }

  const isDrained =
    counts.desiredCount === 0 &&
    counts.runningCount === 0 &&
    counts.pendingCount === 0 &&
    tasksByStatus.RUNNING === 0 &&
    tasksByStatus.PENDING === 0
  if (!isDrained) {
    throw new Error(
      `Api must be fully drained before the first billing outbox deploy: ` +
        `desired=${counts.desiredCount}, running=${counts.runningCount}, pending=${counts.pendingCount}, ` +
        `RUNNING tasks=${tasksByStatus.RUNNING}, PENDING tasks=${tasksByStatus.PENDING}`,
    )
  }

  return { clusterArn, serviceArn: service.serviceArn ?? null }
}

export function preflightBillingOutboxCutover({ app = 'boxlite', stage, region, awsJson }) {
  const marker = readBillingOutboxCutoverMarker({ stage, region, awsJson })
  if (marker.present) return { markerName: marker.markerName, markerRequired: false }

  const drained = assertApiServiceIsDrained({ app, stage, region, awsJson })
  return {
    markerName: marker.markerName,
    markerRequired: true,
    clusterArn: drained.clusterArn,
    serviceArn: drained.serviceArn,
  }
}

export function recordBillingOutboxCutover({ stage, region, ref, awsJson }) {
  const markerName = billingOutboxCutoverMarkerName(stage)
  const resolvedRef = requireValue(ref, 'Selected commit SHA')
  if (!/^[0-9a-f]{40}$/.test(resolvedRef)) {
    throw new Error('Selected commit SHA must be a full lowercase Git SHA')
  }

  const queryAws = awsQuery(region, awsJson)
  queryAws(['ssm', 'put-parameter', '--name', markerName, '--type', 'String', '--value', resolvedRef, '--overwrite'])
  return { markerName }
}

export function writePreflightOutput(outputPath, markerRequired) {
  const resolvedPath = requireValue(outputPath, 'GitHub output path')
  appendFileSync(resolvedPath, `marker_required=${markerRequired ? 'true' : 'false'}\n`, { encoding: 'utf8' })
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      app: { type: 'string', default: 'boxlite' },
      stage: { type: 'string' },
      region: { type: 'string' },
      ref: { type: 'string' },
      'github-output': { type: 'string' },
    },
  })
  const command = positionals[0]
  if (positionals.length !== 1 || !['preflight', 'record'].includes(command)) {
    throw new Error('Usage: billing-outbox-cutover.mjs <preflight|record> --stage STAGE --region REGION')
  }

  if (command === 'preflight') {
    const result = preflightBillingOutboxCutover({
      app: values.app,
      stage: values.stage,
      region: values.region,
    })
    writePreflightOutput(values['github-output'] ?? environment.GITHUB_OUTPUT, result.markerRequired)
    console.log(
      result.markerRequired
        ? `billing-outbox-cutover: Api is fully drained for ${requireStage(values.stage)}; first deploy allowed`
        : `billing-outbox-cutover: cutover already complete for ${requireStage(values.stage)}; normal deploy allowed`,
    )
    return result
  }

  const result = recordBillingOutboxCutover({
    stage: values.stage,
    region: values.region,
    ref: values.ref,
  })
  console.log(`billing-outbox-cutover: recorded cutover completion for ${requireStage(values.stage)}`)
  return result
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  main().catch((error) => {
    console.error(`billing-outbox-cutover: ${error.message}`)
    process.exitCode = 1
  })
}
