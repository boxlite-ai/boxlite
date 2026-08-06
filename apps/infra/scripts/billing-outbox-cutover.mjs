// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { resolveAwsCliPath, runAwsJson } from './proxy-deployment-verify.mjs'

export const BILLING_OUTBOX_MIGRATION_ID = '1786000500000-outbox-cutover-complete'
export const BILLING_OUTBOX_SCALING_SNAPSHOT_ID = '1786000500000-outbox-cutover-scaling-snapshot'
export const BILLING_OUTBOX_SERVICE_NAME = 'Api'
export const BILLING_OUTBOX_SCALABLE_DIMENSION = 'ecs:service:DesiredCount'
export const BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE_ENV = 'BOXLITE_INTERNAL_BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE'

const execFileAsync = promisify(execFile)
const SCALING_SUSPENSION_FIELDS = [
  'DynamicScalingInSuspended',
  'DynamicScalingOutSuspended',
  'ScheduledScalingSuspended',
]

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

export function billingOutboxScalingSnapshotName(stage) {
  return `/boxlite/${requireStage(stage)}/migrations/${BILLING_OUTBOX_SCALING_SNAPSHOT_ID}`
}

function requireImmutableApiImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    throw new Error(
      'First billing outbox cutover requires a preverified immutable ECR Api image; local source-image builds are unsupported',
    )
  }
  const resolvedImage = image.trim()
  if (
    !/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(
      resolvedImage,
    )
  ) {
    throw new Error('Selected immutable Api image must be an exact private ECR repository:tag reference')
  }
  return resolvedImage
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
  try {
    requireImmutableApiImage(parameter.Value)
  } catch (error) {
    throw new Error(`Billing outbox cutover marker ${markerName} does not contain a valid immutable Api image`, {
      cause: error,
    })
  }

  // The marker value is deliberately not returned: callers only need the
  // completed/not-completed decision and must never echo parameter contents.
  return { markerName, present: true }
}

function normalizeSuspendedState(scalableTarget) {
  return Object.fromEntries(
    SCALING_SUSPENSION_FIELDS.map((field) => {
      const value = scalableTarget.SuspendedState?.[field] ?? false
      if (typeof value !== 'boolean') {
        throw new Error(`Api ecs:service:DesiredCount SuspendedState.${field} is not a boolean`)
      }
      return [field, value]
    }),
  )
}

export function readApiCutoverState({ app = 'boxlite', stage, region, awsJson }) {
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
  const clusterArns = taggedClusters.ResourceTagMappingList?.map((resource) => resource.ResourceARN).filter(Boolean)
  if (Array.isArray(clusterArns) && clusterArns.length === 0) {
    throw new Error(
      `Billing outbox cutover requires an existing ECS cluster for ${resolvedApp}/${resolvedStage}; ` +
        `automatic cutover does not bootstrap a fresh stage`,
    )
  }
  const clusterArn = exactlyOne(clusterArns, `ECS cluster tagged sst:app=${resolvedApp}, sst:stage=${resolvedStage}`)

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
  if (typeof service.taskDefinition !== 'string' || !service.taskDefinition.trim()) {
    throw new Error('Api ECS service taskDefinition is missing')
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

  return {
    app: resolvedApp,
    stage: resolvedStage,
    clusterArn,
    serviceArn: service.serviceArn ?? null,
    serviceName: BILLING_OUTBOX_SERVICE_NAME,
    serviceStatus: service.status,
    taskDefinition: service.taskDefinition,
    deployments: service.deployments,
    ...counts,
    scalableTarget: {
      resourceId: scalableTargetResourceId,
      minCapacity: scalableTarget.MinCapacity,
      maxCapacity: scalableTarget.MaxCapacity,
      suspendedState: normalizeSuspendedState(scalableTarget),
    },
  }
}

export function assertApiServiceIsDrained({ app = 'boxlite', stage, region, awsJson }) {
  const queryAws = awsQuery(region, awsJson)
  const state = readApiCutoverState({ app, stage, region, awsJson: queryAws })
  const { scalableTarget } = state

  if (scalableTarget.minCapacity !== 0) {
    throw new Error(
      `Api ecs:service:DesiredCount MinCapacity is ${scalableTarget.minCapacity}; ` +
        `set it to 0 before the first billing outbox deploy`,
    )
  }
  for (const field of SCALING_SUSPENSION_FIELDS) {
    if (!scalableTarget.suspendedState[field]) {
      throw new Error(`Api ecs:service:DesiredCount SuspendedState.${field} must be true during cutover`)
    }
  }

  const tasksByStatus = {}
  for (const status of ['RUNNING', 'PENDING']) {
    const listedTasks = queryAws([
      'ecs',
      'list-tasks',
      '--cluster',
      state.clusterArn,
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
    state.desiredCount === 0 &&
    state.runningCount === 0 &&
    state.pendingCount === 0 &&
    tasksByStatus.RUNNING === 0 &&
    tasksByStatus.PENDING === 0
  if (!isDrained) {
    throw new Error(
      `Api must be fully drained before the first billing outbox deploy: ` +
        `desired=${state.desiredCount}, running=${state.runningCount}, pending=${state.pendingCount}, ` +
        `RUNNING tasks=${tasksByStatus.RUNNING}, PENDING tasks=${tasksByStatus.PENDING}`,
    )
  }

  return { clusterArn: state.clusterArn, serviceArn: state.serviceArn, taskDefinition: state.taskDefinition }
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

function exactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  if (actualKeys.join('\0') !== sortedExpectedKeys.join('\0')) {
    throw new Error(`${label} fields are invalid`)
  }
}

function requireNonNegativeInteger(value, label, { positive = false } = {}) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`${label} must be ${positive ? 'a positive' : 'a non-negative'} integer`)
  }
  return value
}

function createScalingSnapshot(state, selectedImage) {
  if (state.serviceStatus !== 'ACTIVE') {
    throw new Error(`Api ECS service status is ${state.serviceStatus ?? 'missing'}, expected ACTIVE before cutover`)
  }
  if (state.desiredCount < 1 || state.runningCount !== state.desiredCount || state.pendingCount !== 0) {
    throw new Error('Api must have a stable positive desired count before the first cutover snapshot is created')
  }
  if (state.scalableTarget.minCapacity < 1) {
    throw new Error('Api scalable target MinCapacity must be positive before the first cutover snapshot is created')
  }
  if (!Array.isArray(state.deployments)) {
    throw new Error('Api ECS service deployments inventory is missing before cutover')
  }
  const primary = exactlyOne(
    state.deployments.filter((deployment) => deployment.status === 'PRIMARY'),
    'Api PRIMARY deployment before cutover',
  )
  if (
    primary.rolloutState !== 'COMPLETED' ||
    primary.taskDefinition !== state.taskDefinition ||
    primary.desiredCount !== state.desiredCount ||
    primary.runningCount !== state.desiredCount ||
    primary.pendingCount !== 0
  ) {
    throw new Error('Api PRIMARY deployment must be completed and stable before the first cutover snapshot is created')
  }

  return {
    schemaVersion: 2,
    app: state.app,
    stage: state.stage,
    clusterArn: state.clusterArn,
    serviceArn: requireValue(state.serviceArn, 'Api service ARN'),
    serviceName: state.serviceName,
    resourceId: state.scalableTarget.resourceId,
    scalableDimension: BILLING_OUTBOX_SCALABLE_DIMENSION,
    desiredCount: state.desiredCount,
    oldTaskDefinition: state.taskDefinition,
    selectedImage: requireImmutableApiImage(selectedImage),
    minCapacity: state.scalableTarget.minCapacity,
    maxCapacity: state.scalableTarget.maxCapacity,
    suspendedState: { ...state.scalableTarget.suspendedState },
  }
}

export function validateBillingOutboxScalingSnapshot(snapshot, state, selectedImage) {
  exactKeys(
    snapshot,
    [
      'schemaVersion',
      'app',
      'stage',
      'clusterArn',
      'serviceArn',
      'serviceName',
      'resourceId',
      'scalableDimension',
      'desiredCount',
      'oldTaskDefinition',
      'selectedImage',
      'minCapacity',
      'maxCapacity',
      'suspendedState',
    ],
    'Billing outbox scaling snapshot',
  )
  if (snapshot.schemaVersion !== 2) throw new Error('Billing outbox scaling snapshot schemaVersion must be 2')

  for (const [field, expected] of [
    ['app', state.app],
    ['stage', state.stage],
    ['clusterArn', state.clusterArn],
    ['serviceArn', state.serviceArn],
    ['serviceName', BILLING_OUTBOX_SERVICE_NAME],
    ['resourceId', state.scalableTarget.resourceId],
    ['scalableDimension', BILLING_OUTBOX_SCALABLE_DIMENSION],
  ]) {
    if (snapshot[field] !== expected) {
      throw new Error(`Billing outbox scaling snapshot ${field} does not match the live ${state.stage} Api service`)
    }
  }

  requireNonNegativeInteger(snapshot.desiredCount, 'Billing outbox scaling snapshot desiredCount', { positive: true })
  requireNonNegativeInteger(snapshot.minCapacity, 'Billing outbox scaling snapshot minCapacity', { positive: true })
  requireNonNegativeInteger(snapshot.maxCapacity, 'Billing outbox scaling snapshot maxCapacity', { positive: true })
  if (snapshot.maxCapacity < snapshot.minCapacity) {
    throw new Error('Billing outbox scaling snapshot maxCapacity is below minCapacity')
  }
  requireValue(snapshot.oldTaskDefinition, 'Billing outbox scaling snapshot oldTaskDefinition')
  const expectedSelectedImage = requireImmutableApiImage(selectedImage)
  const snapshotSelectedImage = requireImmutableApiImage(snapshot.selectedImage)
  if (snapshotSelectedImage !== expectedSelectedImage) {
    throw new Error('Billing outbox scaling snapshot selectedImage does not match the selected immutable Api image')
  }

  exactKeys(snapshot.suspendedState, SCALING_SUSPENSION_FIELDS, 'Billing outbox scaling snapshot suspendedState')
  for (const field of SCALING_SUSPENSION_FIELDS) {
    if (typeof snapshot.suspendedState[field] !== 'boolean') {
      throw new Error(`Billing outbox scaling snapshot suspendedState.${field} must be a boolean`)
    }
  }
  return snapshot
}

export function readOrCreateBillingOutboxScalingSnapshot({
  app = 'boxlite',
  stage,
  region,
  state,
  selectedImage,
  awsJson,
}) {
  const queryAws = awsQuery(region, awsJson)
  const snapshotName = billingOutboxScalingSnapshotName(stage)
  let response

  try {
    response = queryAws(['ssm', 'get-parameter', '--name', snapshotName])
  } catch (error) {
    if (!isParameterNotFound(error)) throw error

    const snapshot = validateBillingOutboxScalingSnapshot(
      createScalingSnapshot(state, selectedImage),
      state,
      selectedImage,
    )
    try {
      queryAws([
        'ssm',
        'put-parameter',
        '--name',
        snapshotName,
        '--type',
        'String',
        '--value',
        JSON.stringify(snapshot),
      ])
    } catch (error) {
      // Resolve a create response lost after SSM committed, but never adopt a
      // concurrent writer's different recovery target.
      let persisted
      try {
        persisted = queryAws(['ssm', 'get-parameter', '--name', snapshotName])
      } catch {
        throw error
      }
      let persistedSnapshot
      try {
        persistedSnapshot = JSON.parse(persisted?.Parameter?.Value)
        validateBillingOutboxScalingSnapshot(persistedSnapshot, state, selectedImage)
      } catch {
        throw error
      }
      if (JSON.stringify(persistedSnapshot) !== JSON.stringify(snapshot)) throw error
    }
    return { snapshotName, snapshot, created: true }
  }

  const parameter = response?.Parameter
  if (!parameter) throw new Error(`SSM returned no billing outbox scaling snapshot ${snapshotName}`)
  if (parameter.Name !== undefined && parameter.Name !== snapshotName) {
    throw new Error('SSM returned the wrong billing outbox scaling snapshot name')
  }
  if (parameter.Type !== 'String')
    throw new Error(`Billing outbox scaling snapshot ${snapshotName} must be an SSM String`)

  let snapshot
  try {
    snapshot = JSON.parse(parameter.Value)
  } catch (error) {
    throw new Error(`Billing outbox scaling snapshot ${snapshotName} is not valid JSON`, { cause: error })
  }
  validateBillingOutboxScalingSnapshot(snapshot, state, selectedImage)
  // A persisted snapshot is the durable recovery target. The caller always
  // re-applies the full fence before trusting any partially completed state.
  return { snapshotName, snapshot, created: false }
}

function suspendedStateArgument(suspendedState) {
  return SCALING_SUSPENSION_FIELDS.map((field) => `${field}=${suspendedState[field]}`).join(',')
}

function putScalableTarget(queryAws, snapshot, { minCapacity, maxCapacity, suspendedState }) {
  return queryAws([
    'application-autoscaling',
    'register-scalable-target',
    '--service-namespace',
    'ecs',
    '--resource-id',
    snapshot.resourceId,
    '--scalable-dimension',
    BILLING_OUTBOX_SCALABLE_DIMENSION,
    '--min-capacity',
    String(minCapacity),
    '--max-capacity',
    String(maxCapacity),
    '--suspended-state',
    suspendedStateArgument(suspendedState),
  ])
}

function updateApiDesiredCount(queryAws, snapshot, desiredCount) {
  return queryAws([
    'ecs',
    'update-service',
    '--cluster',
    snapshot.clusterArn,
    '--service',
    BILLING_OUTBOX_SERVICE_NAME,
    '--desired-count',
    String(desiredCount),
  ])
}

async function defaultWaitForApiStable(args, region, signal) {
  const awsCliPath = resolveAwsCliPath()
  try {
    await execFileAsync(awsCliPath, [...args, '--region', requireValue(region, 'AWS region'), '--no-cli-pager'], {
      encoding: 'utf8',
      timeout: 11 * 60_000,
      maxBuffer: 1024 * 1024,
      signal,
    })
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`AWS ${args[0]} ${args[1]} failed: ${detail}`, { cause: error })
  }
}

async function waitForApiStable(snapshot, region, awsWait, signal) {
  const waitAws = awsWait ?? ((args) => defaultWaitForApiStable(args, region, signal))
  await waitAws([
    'ecs',
    'wait',
    'services-stable',
    '--cluster',
    snapshot.clusterArn,
    '--services',
    BILLING_OUTBOX_SERVICE_NAME,
  ])
}

export async function fenceBillingOutboxApi({ app = 'boxlite', stage, region, snapshot, awsJson, awsWait, signal }) {
  const queryAws = awsQuery(region, awsJson)
  const failures = []
  const fullySuspended = Object.fromEntries(SCALING_SUSPENSION_FIELDS.map((field) => [field, true]))

  try {
    putScalableTarget(queryAws, snapshot, {
      minCapacity: 0,
      maxCapacity: snapshot.maxCapacity,
      suspendedState: fullySuspended,
    })
  } catch (error) {
    failures.push(error)
  }
  try {
    updateApiDesiredCount(queryAws, snapshot, 0)
  } catch (error) {
    failures.push(error)
  }
  try {
    await waitForApiStable(snapshot, region, awsWait, signal)
    assertApiServiceIsDrained({ app, stage, region, awsJson: queryAws })
  } catch (error) {
    failures.push(error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to establish the billing outbox Api cutover fence')
  }
}

function assertCallerIsNotRoot(queryAws) {
  const identity = queryAws(['sts', 'get-caller-identity'])
  const arn = requireValue(identity?.Arn, 'AWS caller ARN')
  if (/^arn:[^:]+:iam::[0-9]{12}:root$/.test(arn)) {
    throw new Error('refusing first billing outbox cutover with the AWS account root caller')
  }
  return arn
}

export async function prepareBillingOutboxCutover({ app = 'boxlite', stage, region, image, awsJson, awsWait, signal }) {
  const queryAws = awsQuery(region, awsJson)
  const marker = readBillingOutboxCutoverMarker({ stage, region, awsJson: queryAws })
  if (marker.present) return { markerName: marker.markerName, required: false }

  assertCallerIsNotRoot(queryAws)
  const selectedImage = requireImmutableApiImage(image)
  const state = readApiCutoverState({ app, stage, region, awsJson: queryAws })
  const { snapshotName, snapshot, created } = readOrCreateBillingOutboxScalingSnapshot({
    app,
    stage,
    region,
    state,
    selectedImage,
    awsJson: queryAws,
  })

  try {
    await fenceBillingOutboxApi({ app, stage, region, snapshot, awsJson: queryAws, awsWait, signal })
  } catch (error) {
    try {
      await fenceBillingOutboxApi({ app, stage, region, snapshot, awsJson: queryAws, awsWait })
    } catch (fenceError) {
      throw new AggregateError([error, fenceError], 'billing outbox cutover preparation and recovery fence failed')
    }
    throw error
  }
  const preflight = preflightBillingOutboxCutover({ app, stage, region, awsJson: queryAws })
  if (!preflight.markerRequired) throw new Error('billing outbox cutover marker appeared while Api was being fenced')

  return {
    markerName: marker.markerName,
    required: true,
    selectedImage,
    snapshotName,
    snapshot,
    snapshotCreated: created,
  }
}

function selectedApiImage(taskDefinition, expectedImage) {
  if (!taskDefinition || !Array.isArray(taskDefinition.containerDefinitions)) {
    throw new Error('Api task definition lookup returned no container inventory')
  }
  const container = exactlyOne(
    taskDefinition.containerDefinitions.filter((candidate) => candidate.name === BILLING_OUTBOX_SERVICE_NAME),
    'Api task definition container',
  )
  const image = requireValue(container.image, 'Api task definition image')
  if (image !== requireValue(expectedImage, 'Expected Api image')) {
    throw new Error('Api task definition image is not the exact repository and tag verified before deployment')
  }
  return image
}

export function verifyBillingOutboxDeploymentWhileDrained({ app = 'boxlite', stage, region, context, awsJson }) {
  const queryAws = awsQuery(region, awsJson)
  const preflight = preflightBillingOutboxCutover({ app, stage, region, awsJson: queryAws })
  if (!preflight.markerRequired) throw new Error('billing outbox cutover marker exists before the new Api was verified')

  const state = readApiCutoverState({ app, stage, region, awsJson: queryAws })
  if (state.taskDefinition === context.snapshot.oldTaskDefinition) {
    throw new Error('SST did not replace the old Api task definition while the service was drained')
  }
  const described = queryAws(['ecs', 'describe-task-definition', '--task-definition', state.taskDefinition])
  const image = selectedApiImage(described?.taskDefinition, context.selectedImage)
  return { taskDefinition: state.taskDefinition, image }
}

function assertScalableTargetMatchesSnapshot(state, snapshot) {
  const target = state.scalableTarget
  if (target.minCapacity !== snapshot.minCapacity || target.maxCapacity !== snapshot.maxCapacity) {
    throw new Error('Api scalable target capacity did not restore to the recorded snapshot')
  }
  for (const field of SCALING_SUSPENSION_FIELDS) {
    if (target.suspendedState[field] !== snapshot.suspendedState[field]) {
      throw new Error(`Api scalable target SuspendedState.${field} did not restore to the recorded snapshot`)
    }
  }
}

function assertApiRunsOnlyTaskDefinition(queryAws, state, snapshot, deployedTaskDefinition, expectedCount) {
  if (state.desiredCount !== expectedCount || state.runningCount !== expectedCount || state.pendingCount !== 0) {
    throw new Error(
      `Api did not stabilize at desired=${expectedCount}: ` +
        `desired=${state.desiredCount}, running=${state.runningCount}, pending=${state.pendingCount}`,
    )
  }
  if (state.taskDefinition !== deployedTaskDefinition) {
    throw new Error('Api task definition changed after the drained deployment was verified')
  }

  const listed = queryAws([
    'ecs',
    'list-tasks',
    '--cluster',
    snapshot.clusterArn,
    '--service-name',
    BILLING_OUTBOX_SERVICE_NAME,
    '--desired-status',
    'RUNNING',
  ])
  if (!Array.isArray(listed.taskArns) || listed.taskArns.length !== expectedCount) {
    throw new Error(`Api running task inventory does not contain exactly ${expectedCount} task(s)`)
  }
  const described = queryAws(['ecs', 'describe-tasks', '--cluster', snapshot.clusterArn, '--tasks', ...listed.taskArns])
  if (!Array.isArray(described.failures) || described.failures.length > 0 || !Array.isArray(described.tasks)) {
    throw new Error('Api running task lookup returned an incomplete inventory')
  }
  if (
    described.tasks.length !== expectedCount ||
    described.tasks.some((task) => task.taskDefinitionArn !== deployedTaskDefinition || task.lastStatus !== 'RUNNING')
  ) {
    throw new Error('Api running tasks are not exclusively on the verified outbox-aware task definition')
  }
}

export async function startBillingOutboxApiForVerification({
  app = 'boxlite',
  stage,
  region,
  context,
  deployedTaskDefinition,
  awsJson,
  awsWait,
  signal,
}) {
  const queryAws = awsQuery(region, awsJson)
  const { snapshot } = context
  updateApiDesiredCount(queryAws, snapshot, 1)
  await waitForApiStable(snapshot, region, awsWait, signal)

  const state = readApiCutoverState({ app, stage, region, awsJson: queryAws })
  if (state.scalableTarget.minCapacity !== 0) {
    throw new Error('Api scalable target MinCapacity changed before public cutover verification')
  }
  for (const field of SCALING_SUSPENSION_FIELDS) {
    if (!state.scalableTarget.suspendedState[field]) {
      throw new Error(`Api scalable target SuspendedState.${field} changed before public cutover verification`)
    }
  }
  assertApiRunsOnlyTaskDefinition(queryAws, state, snapshot, deployedTaskDefinition, 1)
  return { taskDefinition: deployedTaskDefinition }
}

export async function restoreBillingOutboxScaling({
  app = 'boxlite',
  stage,
  region,
  context,
  deployedTaskDefinition,
  awsJson,
  awsWait,
  signal,
}) {
  const queryAws = awsQuery(region, awsJson)
  const { snapshot } = context
  putScalableTarget(queryAws, snapshot, {
    minCapacity: snapshot.minCapacity,
    maxCapacity: snapshot.maxCapacity,
    suspendedState: snapshot.suspendedState,
  })
  updateApiDesiredCount(queryAws, snapshot, snapshot.desiredCount)
  await waitForApiStable(snapshot, region, awsWait, signal)

  const state = readApiCutoverState({ app, stage, region, awsJson: queryAws })
  assertScalableTargetMatchesSnapshot(state, snapshot)
  assertApiRunsOnlyTaskDefinition(queryAws, state, snapshot, deployedTaskDefinition, snapshot.desiredCount)
  return { taskDefinition: deployedTaskDefinition }
}

export function recordBillingOutboxCutover({ stage, region, image, awsJson }) {
  const markerName = billingOutboxCutoverMarkerName(stage)
  const selectedImage = requireImmutableApiImage(image)

  const queryAws = awsQuery(region, awsJson)
  try {
    queryAws(['ssm', 'put-parameter', '--name', markerName, '--type', 'String', '--value', selectedImage])
  } catch (error) {
    // A response can be lost after SSM commits the create. Resolve that ambiguity
    // without ever overwriting another deploy's immutable completion identity.
    let response
    try {
      response = queryAws(['ssm', 'get-parameter', '--name', markerName])
    } catch {
      throw error
    }
    const parameter = response?.Parameter
    if (parameter?.Name !== markerName || parameter.Type !== 'String' || parameter.Value !== selectedImage) {
      throw error
    }
  }
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
      image: { type: 'string' },
      'github-output': { type: 'string' },
    },
  })
  const command = positionals[0]
  if (positionals.length !== 1 || !['preflight', 'record'].includes(command)) {
    throw new Error(
      'Usage: billing-outbox-cutover.mjs <preflight|record> --stage STAGE --region REGION [--image ECR_REPOSITORY_TAG]',
    )
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
    image: values.image,
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
