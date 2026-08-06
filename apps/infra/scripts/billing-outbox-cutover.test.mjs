// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { load } from 'js-yaml'

import {
  BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE_ENV,
  BILLING_OUTBOX_MIGRATION_ID,
  BILLING_OUTBOX_SCALING_SNAPSHOT_ID,
  assertApiServiceIsDrained,
  billingOutboxCutoverMarkerName,
  billingOutboxScalingSnapshotName,
  fenceBillingOutboxApi,
  prepareBillingOutboxCutover,
  preflightBillingOutboxCutover,
  readBillingOutboxCutoverMarker,
  readOrCreateBillingOutboxScalingSnapshot,
  recordBillingOutboxCutover,
  restoreBillingOutboxScaling,
  startBillingOutboxApiForVerification,
  validateBillingOutboxScalingSnapshot,
  verifyBillingOutboxDeploymentWhileDrained,
  writePreflightOutput,
} from './billing-outbox-cutover.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-infra.yml')
const RELEASE_DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-release.yml')
const SST_WRAPPER = join(REPO_ROOT, 'apps/infra/scripts/sst-with-cloudflare.mjs')
const CLUSTER_ARN = 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/boxlite-dev-cluster'
const SCALABLE_TARGET_RESOURCE_ID = 'service/boxlite-dev-cluster/Api'
const SERVICE_ARN = 'arn:aws:ecs:ap-southeast-1:123456789012:service/boxlite-dev-cluster/Api'
const MARKER_NAME = `/boxlite/dev/migrations/${BILLING_OUTBOX_MIGRATION_ID}`
const SNAPSHOT_NAME = `/boxlite/dev/migrations/${BILLING_OUTBOX_SCALING_SNAPSHOT_ID}`
const SELECTED_REF = '0123456789abcdef0123456789abcdef01234567'
const OLD_TASK_DEFINITION = 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/boxlite-dev-Api:1'
const NEW_TASK_DEFINITION = 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/boxlite-dev-Api:2'
const ASSUMED_ROLE_ARN = 'arn:aws:sts::123456789012:assumed-role/boxlite-app-dev-deploy/cutover-test'
const EXPECTED_API_IMAGE = `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-app-dev-api:v0.9.7-${SELECTED_REF}`
const RELEASE_API_IMAGE = '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-app-dev-api:v0.9.7'
const FULLY_SUSPENDED = {
  DynamicScalingInSuspended: true,
  DynamicScalingOutSuspended: true,
  ScheduledScalingSuspended: true,
}

function parameterNotFound() {
  return new Error('AWS ssm get-parameter failed: An error occurred (ParameterNotFound) when calling GetParameter')
}

function callKey(args) {
  const operation = args.slice(0, 2).join(' ')
  if (operation === 'ecs list-tasks') return `${operation} ${args[args.indexOf('--desired-status') + 1]}`
  return operation
}

function createAwsFixture(overrides = {}) {
  const responses = {
    'ssm get-parameter': parameterNotFound(),
    'resourcegroupstaggingapi get-resources': {
      ResourceTagMappingList: [{ ResourceARN: CLUSTER_ARN }],
    },
    'ecs describe-services': {
      failures: [],
      services: [
        {
          serviceArn: SERVICE_ARN,
          serviceName: 'Api',
          desiredCount: 0,
          runningCount: 0,
          pendingCount: 0,
          taskDefinition: OLD_TASK_DEFINITION,
        },
      ],
    },
    'application-autoscaling describe-scalable-targets': {
      ScalableTargets: [
        {
          ServiceNamespace: 'ecs',
          ResourceId: SCALABLE_TARGET_RESOURCE_ID,
          ScalableDimension: 'ecs:service:DesiredCount',
          MinCapacity: 0,
          MaxCapacity: 4,
          SuspendedState: FULLY_SUSPENDED,
        },
      ],
    },
    'ecs list-tasks RUNNING': { taskArns: [] },
    'ecs list-tasks PENDING': { taskArns: [] },
    'ssm put-parameter': { Version: 1 },
    ...overrides,
  }
  const calls = []
  return {
    calls,
    awsJson(args) {
      calls.push(args)
      const key = callKey(args)
      if (!(key in responses)) throw new Error(`unexpected AWS call: ${args.join(' ')}`)
      const response = responses[key]
      if (response instanceof Error) throw response
      return response
    },
  }
}

function createDeployFixture({ markerPresent = false, rootCaller = false, snapshot, initiallyFenced = false } = {}) {
  const calls = []
  const waits = []
  const parameters = new Map()
  const failures = new Map()
  const state = {
    desiredCount: initiallyFenced ? 0 : 1,
    runningCount: initiallyFenced ? 0 : 1,
    pendingCount: 0,
    taskDefinition: OLD_TASK_DEFINITION,
    minCapacity: initiallyFenced ? 0 : 1,
    maxCapacity: 4,
    suspendedState: initiallyFenced
      ? { ...FULLY_SUSPENDED }
      : {
          DynamicScalingInSuspended: false,
          DynamicScalingOutSuspended: false,
          ScheduledScalingSuspended: false,
        },
  }
  if (markerPresent) parameters.set(MARKER_NAME, EXPECTED_API_IMAGE)
  if (snapshot) parameters.set(SNAPSHOT_NAME, JSON.stringify(snapshot))

  const operation = (args) => {
    const base = args.slice(0, 2).join(' ')
    if (base.startsWith('ssm ')) return `${base} ${args[args.indexOf('--name') + 1]}`
    return base
  }
  const maybeFail = (args) => {
    const key = operation(args)
    const failure = failures.get(key)
    if (!failure) return
    failures.delete(key)
    throw failure
  }
  const runningTaskArns = () =>
    Array.from({ length: state.runningCount }, (_, index) => `arn:aws:ecs:task/api-${index + 1}`)

  return {
    calls,
    waits,
    parameters,
    state,
    failOnce(key, error = new Error(`injected ${key} failure`)) {
      failures.set(key, error)
    },
    installNewTaskDefinition() {
      state.taskDefinition = NEW_TASK_DEFINITION
    },
    awsJson(args) {
      calls.push(args)
      maybeFail(args)
      const key = operation(args)

      if (key.startsWith('ssm get-parameter ')) {
        const name = args[args.indexOf('--name') + 1]
        if (!parameters.has(name)) throw parameterNotFound()
        return { Parameter: { Name: name, Type: 'String', Value: parameters.get(name) } }
      }
      if (key.startsWith('ssm put-parameter ')) {
        const name = args[args.indexOf('--name') + 1]
        if (parameters.has(name) && !args.includes('--overwrite')) {
          throw new Error('ParameterAlreadyExists')
        }
        parameters.set(name, args[args.indexOf('--value') + 1])
        return { Version: 1 }
      }
      if (key === 'sts get-caller-identity') {
        return {
          Account: '123456789012',
          Arn: rootCaller ? 'arn:aws:iam::123456789012:root' : ASSUMED_ROLE_ARN,
        }
      }
      if (key === 'resourcegroupstaggingapi get-resources') {
        return { ResourceTagMappingList: [{ ResourceARN: CLUSTER_ARN }] }
      }
      if (key === 'ecs describe-services') {
        return {
          failures: [],
          services: [
            {
              serviceArn: SERVICE_ARN,
              serviceName: 'Api',
              status: 'ACTIVE',
              desiredCount: state.desiredCount,
              runningCount: state.runningCount,
              pendingCount: state.pendingCount,
              taskDefinition: state.taskDefinition,
              deployments: [
                {
                  status: 'PRIMARY',
                  rolloutState: 'COMPLETED',
                  desiredCount: state.desiredCount,
                  runningCount: state.runningCount,
                  pendingCount: state.pendingCount,
                  taskDefinition: state.taskDefinition,
                },
              ],
            },
          ],
        }
      }
      if (key === 'application-autoscaling describe-scalable-targets') {
        return {
          ScalableTargets: [
            {
              ServiceNamespace: 'ecs',
              ResourceId: SCALABLE_TARGET_RESOURCE_ID,
              ScalableDimension: 'ecs:service:DesiredCount',
              MinCapacity: state.minCapacity,
              MaxCapacity: state.maxCapacity,
              SuspendedState: { ...state.suspendedState },
            },
          ],
        }
      }
      if (key === 'application-autoscaling register-scalable-target') {
        state.minCapacity = Number(args[args.indexOf('--min-capacity') + 1])
        state.maxCapacity = Number(args[args.indexOf('--max-capacity') + 1])
        state.suspendedState = Object.fromEntries(
          args[args.indexOf('--suspended-state') + 1]
            .split(',')
            .map((pair) => pair.split('=').map((value, index) => (index === 1 ? value === 'true' : value))),
        )
        return { ScalableTargetARN: 'arn:aws:application-autoscaling:target' }
      }
      if (key === 'ecs update-service') {
        state.desiredCount = Number(args[args.indexOf('--desired-count') + 1])
        return { service: { serviceArn: SERVICE_ARN, desiredCount: state.desiredCount } }
      }
      if (key === 'ecs list-tasks') {
        const desiredStatus = args[args.indexOf('--desired-status') + 1]
        return { taskArns: desiredStatus === 'RUNNING' ? runningTaskArns() : [] }
      }
      if (key === 'ecs describe-task-definition') {
        const taskDefinition = args[args.indexOf('--task-definition') + 1]
        return {
          taskDefinition: {
            taskDefinitionArn: taskDefinition,
            containerDefinitions: [
              {
                name: 'Api',
                image:
                  taskDefinition === NEW_TASK_DEFINITION
                    ? EXPECTED_API_IMAGE
                    : '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-app-dev-api:v0.9.7-old',
              },
            ],
          },
        }
      }
      if (key === 'ecs describe-tasks') {
        const taskArns = args.slice(args.indexOf('--tasks') + 1)
        return {
          failures: [],
          tasks: taskArns.map((taskArn) => ({
            taskArn,
            taskDefinitionArn: state.taskDefinition,
            lastStatus: 'RUNNING',
          })),
        }
      }
      throw new Error(`unexpected AWS call: ${args.join(' ')}`)
    },
    async awsWait(args) {
      waits.push(args)
      state.runningCount = state.desiredCount
      state.pendingCount = 0
    },
  }
}

function normalScalingSnapshot() {
  return {
    schemaVersion: 2,
    app: 'boxlite',
    stage: 'dev',
    clusterArn: CLUSTER_ARN,
    serviceArn: SERVICE_ARN,
    serviceName: 'Api',
    resourceId: SCALABLE_TARGET_RESOURCE_ID,
    scalableDimension: 'ecs:service:DesiredCount',
    desiredCount: 1,
    oldTaskDefinition: OLD_TASK_DEFINITION,
    selectedImage: EXPECTED_API_IMAGE,
    minCapacity: 1,
    maxCapacity: 4,
    suspendedState: {
      DynamicScalingInSuspended: false,
      DynamicScalingOutSuspended: false,
      ScheduledScalingSuspended: false,
    },
  }
}

test('builds the stage-scoped String marker name and rejects path injection', () => {
  assert.equal(billingOutboxCutoverMarkerName('dev'), MARKER_NAME)
  assert.throws(() => billingOutboxCutoverMarkerName('../prod'), /unsupported characters/)
})

test('an existing String marker allows a normal deploy without inspecting ECS', () => {
  const fixture = createAwsFixture({
    'ssm get-parameter': {
      Parameter: { Name: MARKER_NAME, Type: 'String', Value: EXPECTED_API_IMAGE },
    },
  })

  const result = preflightBillingOutboxCutover({
    app: 'boxlite',
    stage: 'dev',
    region: 'ap-southeast-1',
    awsJson: fixture.awsJson,
  })

  assert.deepEqual(result, { markerName: MARKER_NAME, markerRequired: false })
  assert.deepEqual(fixture.calls, [['ssm', 'get-parameter', '--name', MARKER_NAME]])
  assert.equal('Value' in result, false, 'the marker value must never escape the SSM reader')
})

test('only ParameterNotFound enters the one-time drain path', () => {
  const fixture = createAwsFixture({
    'ssm get-parameter': new Error('AWS ssm get-parameter failed: AccessDeniedException'),
  })

  assert.throws(
    () =>
      preflightBillingOutboxCutover({
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /AccessDeniedException/,
  )
  assert.equal(fixture.calls.length, 1, 'an unreadable marker must fail closed before ECS inspection')
})

test('rejects a non-String or malformed marker instead of treating it as complete', () => {
  for (const parameter of [
    { Name: MARKER_NAME, Type: 'SecureString', Value: EXPECTED_API_IMAGE },
    { Name: MARKER_NAME, Type: 'String', Value: '' },
    { Name: MARKER_NAME, Type: 'String', Value: SELECTED_REF },
    { Name: MARKER_NAME, Type: 'String', Value: 'public.example.com/boxlite-api:v0.9.7' },
  ]) {
    const fixture = createAwsFixture({ 'ssm get-parameter': { Parameter: parameter } })
    assert.throws(
      () =>
        readBillingOutboxCutoverMarker({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      /must be an SSM String|does not contain a valid immutable Api image/,
    )
  }
})

test('a missing marker allows the first deploy only after a fully drained Api service', () => {
  const fixture = createAwsFixture()

  const result = preflightBillingOutboxCutover({
    app: 'boxlite',
    stage: 'dev',
    region: 'ap-southeast-1',
    awsJson: fixture.awsJson,
  })

  assert.deepEqual(result, {
    markerName: MARKER_NAME,
    markerRequired: true,
    clusterArn: CLUSTER_ARN,
    serviceArn: SERVICE_ARN,
  })
  assert.deepEqual(fixture.calls, [
    ['ssm', 'get-parameter', '--name', MARKER_NAME],
    [
      'resourcegroupstaggingapi',
      'get-resources',
      '--resource-type-filters',
      'ecs:cluster',
      '--tag-filters',
      'Key=sst:app,Values=boxlite',
      'Key=sst:stage,Values=dev',
    ],
    ['ecs', 'describe-services', '--cluster', CLUSTER_ARN, '--services', 'Api'],
    [
      'application-autoscaling',
      'describe-scalable-targets',
      '--service-namespace',
      'ecs',
      '--resource-ids',
      SCALABLE_TARGET_RESOURCE_ID,
      '--scalable-dimension',
      'ecs:service:DesiredCount',
    ],
    ['ecs', 'list-tasks', '--cluster', CLUSTER_ARN, '--service-name', 'Api', '--desired-status', 'RUNNING'],
    ['ecs', 'list-tasks', '--cluster', CLUSTER_ARN, '--service-name', 'Api', '--desired-status', 'PENDING'],
  ])
})

for (const countField of ['desiredCount', 'runningCount', 'pendingCount']) {
  test(`fails closed when Api ${countField} is nonzero`, () => {
    const fixture = createAwsFixture({
      'ecs describe-services': {
        failures: [],
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'Api',
            desiredCount: 0,
            runningCount: 0,
            pendingCount: 0,
            taskDefinition: OLD_TASK_DEFINITION,
            [countField]: 1,
          },
        ],
      },
    })

    assert.throws(
      () =>
        assertApiServiceIsDrained({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      new RegExp(`${countField.replace('Count', '')}=1`),
    )
  })
}

test('fails until the exact Api scalable target has MinCapacity zero', () => {
  const fixture = createAwsFixture({
    'application-autoscaling describe-scalable-targets': {
      ScalableTargets: [
        {
          ServiceNamespace: 'ecs',
          ResourceId: SCALABLE_TARGET_RESOURCE_ID,
          ScalableDimension: 'ecs:service:DesiredCount',
          MinCapacity: 1,
          MaxCapacity: 4,
          SuspendedState: FULLY_SUSPENDED,
        },
      ],
    },
  })

  assert.throws(
    () =>
      assertApiServiceIsDrained({
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /MinCapacity is 1; set it to 0/,
  )
  assert.equal(
    fixture.calls.some((args) => args[0] === 'ecs' && args[1] === 'list-tasks'),
    false,
    'an unsafe scaling floor must fail before the task snapshot can be accepted',
  )
})

test('fails closed on malformed or mismatched Api scalable-target inventory', () => {
  const validTarget = {
    ServiceNamespace: 'ecs',
    ResourceId: SCALABLE_TARGET_RESOURCE_ID,
    ScalableDimension: 'ecs:service:DesiredCount',
    MinCapacity: 0,
    MaxCapacity: 4,
    SuspendedState: FULLY_SUSPENDED,
  }
  const cases = [
    {
      response: {},
      pattern: /returned no scalable-target inventory/,
    },
    {
      response: { ScalableTargets: [] },
      pattern: /expected exactly one, found 0/,
    },
    {
      response: { ScalableTargets: [validTarget, validTarget] },
      pattern: /expected exactly one, found 2/,
    },
    {
      response: { ScalableTargets: [{ ...validTarget, ResourceId: 'service/other/Api' }] },
      pattern: /ResourceId is service\/other\/Api/,
    },
    {
      response: { ScalableTargets: [{ ...validTarget, ServiceNamespace: 'custom-resource' }] },
      pattern: /ServiceNamespace is custom-resource/,
    },
    {
      response: { ScalableTargets: [{ ...validTarget, ScalableDimension: 'ecs:service:Other' }] },
      pattern: /ScalableDimension is ecs:service:Other/,
    },
    {
      response: { ScalableTargets: [{ ...validTarget, MinCapacity: undefined }] },
      pattern: /MinCapacity is missing/,
    },
    {
      response: { ScalableTargets: [{ ...validTarget, MinCapacity: 2, MaxCapacity: 1 }] },
      pattern: /MaxCapacity is below MinCapacity/,
    },
  ]

  for (const { response, pattern } of cases) {
    const fixture = createAwsFixture({ 'application-autoscaling describe-scalable-targets': response })
    assert.throws(
      () =>
        assertApiServiceIsDrained({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      pattern,
    )
  }
})

for (const status of ['RUNNING', 'PENDING']) {
  test(`fails closed when a ${status} task remains despite zero service counters`, () => {
    const fixture = createAwsFixture({
      [`ecs list-tasks ${status}`]: { taskArns: [`arn:aws:ecs:task/${status.toLowerCase()}`] },
    })

    assert.throws(
      () =>
        assertApiServiceIsDrained({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      new RegExp(`${status} tasks=1`),
    )
  })
}

test('fails closed on ambiguous cluster, service failures, and incomplete count/task inventories', () => {
  const cases = [
    {
      overrides: { 'resourcegroupstaggingapi get-resources': { ResourceTagMappingList: [] } },
      pattern: /automatic cutover does not bootstrap a fresh stage/,
    },
    {
      overrides: { 'ecs describe-services': { failures: [{ reason: 'MISSING' }], services: [] } },
      pattern: /reported 1 failure/,
    },
    {
      overrides: {
        'ecs describe-services': {
          failures: [],
          services: [
            {
              serviceArn: SERVICE_ARN,
              serviceName: 'Api',
              desiredCount: 0,
              runningCount: 0,
              taskDefinition: OLD_TASK_DEFINITION,
            },
          ],
        },
      },
      pattern: /pendingCount is missing/,
    },
    {
      overrides: { 'ecs list-tasks RUNNING': {} },
      pattern: /returned no task inventory/,
    },
  ]

  for (const { overrides, pattern } of cases) {
    const fixture = createAwsFixture(overrides)
    assert.throws(
      () =>
        assertApiServiceIsDrained({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      pattern,
    )
  }
})

test('records the exact immutable image as a String marker without returning its value', () => {
  const fixture = createAwsFixture()

  const result = recordBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson: fixture.awsJson,
  })

  assert.deepEqual(result, { markerName: MARKER_NAME })
  assert.deepEqual(fixture.calls, [
    ['ssm', 'put-parameter', '--name', MARKER_NAME, '--type', 'String', '--value', EXPECTED_API_IMAGE],
  ])
  assert.throws(
    () =>
      recordBillingOutboxCutover({
        stage: 'dev',
        region: 'ap-southeast-1',
        image: 'main',
        awsJson: fixture.awsJson,
      }),
    /exact private ECR repository:tag reference/,
  )
})

test('accepts a lost marker-create response only when SSM holds the same immutable image', () => {
  const calls = []
  const result = recordBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson(args) {
      calls.push(args)
      if (args[1] === 'put-parameter') throw new Error('response lost')
      return { Parameter: { Name: MARKER_NAME, Type: 'String', Value: EXPECTED_API_IMAGE } }
    },
  })

  assert.deepEqual(result, { markerName: MARKER_NAME })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].includes('--overwrite'), false)

  assert.throws(
    () =>
      recordBillingOutboxCutover({
        stage: 'dev',
        region: 'ap-southeast-1',
        image: EXPECTED_API_IMAGE,
        awsJson(args) {
          if (args[1] === 'put-parameter') throw new Error('ParameterAlreadyExists')
          return { Parameter: { Name: MARKER_NAME, Type: 'String', Value: RELEASE_API_IMAGE } }
        },
      }),
    /ParameterAlreadyExists/,
  )
})

test('uses a separate stage-scoped scaling snapshot and skips all cutover writes after completion', async () => {
  assert.equal(billingOutboxScalingSnapshotName('dev'), SNAPSHOT_NAME)
  const fixture = createDeployFixture({ markerPresent: true, rootCaller: true })

  const result = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })

  assert.deepEqual(result, { markerName: MARKER_NAME, required: false })
  assert.deepEqual(fixture.calls, [['ssm', 'get-parameter', '--name', MARKER_NAME]])
})

test('refuses the AWS account root before creating the snapshot or changing ECS', async () => {
  const fixture = createDeployFixture({ rootCaller: true })

  await assert.rejects(
    prepareBillingOutboxCutover({
      stage: 'dev',
      region: 'ap-southeast-1',
      image: EXPECTED_API_IMAGE,
      awsJson: fixture.awsJson,
      awsWait: fixture.awsWait,
    }),
    /refusing first billing outbox cutover with the AWS account root caller/,
  )
  assert.equal(
    fixture.calls.some((args) => ['put-parameter', 'register-scalable-target', 'update-service'].includes(args[1])),
    false,
  )
})

test('rejects an unaddressed local source build before creating the snapshot or changing ECS', async () => {
  const fixture = createDeployFixture()

  await assert.rejects(
    prepareBillingOutboxCutover({
      stage: 'dev',
      region: 'ap-southeast-1',
      awsJson: fixture.awsJson,
      awsWait: fixture.awsWait,
    }),
    /local source-image builds are unsupported/,
  )
  assert.equal(
    fixture.calls.some((args) => ['put-parameter', 'register-scalable-target', 'update-service'].includes(args[1])),
    false,
  )
})

test('accepts an exact immutable release image as the first-cutover identity', async () => {
  const fixture = createDeployFixture()

  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: RELEASE_API_IMAGE,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })

  assert.equal(context.selectedImage, RELEASE_API_IMAGE)
  assert.equal(context.required, true)
})

test('persists an immutable stable-state snapshot before fencing and draining Api', async () => {
  const fixture = createDeployFixture()

  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })

  assert.equal(context.required, true)
  assert.equal(context.snapshotCreated, true)
  assert.deepEqual(context.snapshot, normalScalingSnapshot())
  assert.equal(fixture.state.desiredCount, 0)
  assert.equal(fixture.state.runningCount, 0)
  assert.equal(fixture.state.minCapacity, 0)
  assert.deepEqual(fixture.state.suspendedState, FULLY_SUSPENDED)

  const snapshotPut = fixture.calls.findIndex(
    (args) => args[0] === 'ssm' && args[1] === 'put-parameter' && args.includes(SNAPSHOT_NAME),
  )
  const scalingFence = fixture.calls.findIndex(
    (args) => args[0] === 'application-autoscaling' && args[1] === 'register-scalable-target',
  )
  assert.ok(snapshotPut >= 0 && snapshotPut < scalingFence)
  assert.equal(fixture.calls[snapshotPut].includes('--overwrite'), false)
  assert.deepEqual(JSON.parse(fixture.parameters.get(SNAPSHOT_NAME)), normalScalingSnapshot())
  assert.equal(fixture.parameters.has(MARKER_NAME), false)
})

test('continues after a lost snapshot-create response only when the persisted snapshot is identical', async () => {
  const fixture = createDeployFixture()
  let loseResponse = true
  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson(args) {
      const response = fixture.awsJson(args)
      if (loseResponse && args[0] === 'ssm' && args[1] === 'put-parameter' && args.includes(SNAPSHOT_NAME)) {
        loseResponse = false
        throw new Error('snapshot create response lost')
      }
      return response
    },
    awsWait: fixture.awsWait,
  })

  assert.equal(context.snapshotCreated, true)
  assert.equal(fixture.state.desiredCount, 0)
  assert.deepEqual(JSON.parse(fixture.parameters.get(SNAPSHOT_NAME)), normalScalingSnapshot())
})

for (const [name, partialState] of [
  [
    'desired task still running',
    {
      minCapacity: 0,
      desiredCount: 1,
      runningCount: 1,
      suspendedState: { ...FULLY_SUSPENDED, DynamicScalingOutSuspended: false },
    },
  ],
  [
    'scaling floor still active',
    {
      minCapacity: 1,
      desiredCount: 0,
      runningCount: 0,
      suspendedState: {
        DynamicScalingInSuspended: false,
        DynamicScalingOutSuspended: false,
        ScheduledScalingSuspended: false,
      },
    },
  ],
  [
    'scaling suspension only partially applied',
    {
      minCapacity: 0,
      desiredCount: 0,
      runningCount: 0,
      suspendedState: { ...FULLY_SUSPENDED, ScheduledScalingSuspended: false },
    },
  ],
]) {
  test(`reuses the persisted snapshot and re-applies the full fence when ${name}`, async () => {
    const fixture = createDeployFixture({ snapshot: normalScalingSnapshot(), initiallyFenced: true })
    Object.assign(fixture.state, partialState)

    const context = await prepareBillingOutboxCutover({
      stage: 'dev',
      region: 'ap-southeast-1',
      image: EXPECTED_API_IMAGE,
      awsJson: fixture.awsJson,
      awsWait: fixture.awsWait,
    })

    assert.equal(context.snapshotCreated, false)
    assert.equal(fixture.state.minCapacity, 0)
    assert.equal(fixture.state.desiredCount, 0)
    assert.equal(fixture.state.runningCount, 0)
    assert.deepEqual(fixture.state.suspendedState, FULLY_SUSPENDED)
    assert.equal(
      fixture.calls.some((args) => args[0] === 'ssm' && args[1] === 'put-parameter' && args.includes(SNAPSHOT_NAME)),
      false,
    )
    assert.equal(
      fixture.calls.some((args) => args[0] === 'application-autoscaling' && args[1] === 'register-scalable-target'),
      true,
    )
  })
}

test('rejects a retry with a different immutable image before any fence writes', async () => {
  const fixture = createDeployFixture({ snapshot: normalScalingSnapshot(), initiallyFenced: true })

  await assert.rejects(
    prepareBillingOutboxCutover({
      stage: 'dev',
      region: 'ap-southeast-1',
      image: RELEASE_API_IMAGE,
      awsJson: fixture.awsJson,
      awsWait: fixture.awsWait,
    }),
    /snapshot selectedImage does not match the selected immutable Api image/,
  )
  assert.equal(
    fixture.calls.some((args) => ['register-scalable-target', 'update-service'].includes(args[1])),
    false,
  )
  assert.equal(
    fixture.calls.some((args) => args[0] === 'ssm' && args[1] === 'put-parameter'),
    false,
  )
})

test('validates every persisted snapshot field before reuse', () => {
  const state = {
    app: 'boxlite',
    stage: 'dev',
    clusterArn: CLUSTER_ARN,
    serviceArn: SERVICE_ARN,
    scalableTarget: { resourceId: SCALABLE_TARGET_RESOURCE_ID },
  }
  const cases = [
    [{ ...normalScalingSnapshot(), schemaVersion: 3 }, /schemaVersion must be 2/],
    [{ ...normalScalingSnapshot(), stage: 'prod' }, /stage does not match/],
    [{ ...normalScalingSnapshot(), resourceId: 'service/other/Api' }, /resourceId does not match/],
    [{ ...normalScalingSnapshot(), desiredCount: 0 }, /desiredCount must be a positive integer/],
    [{ ...normalScalingSnapshot(), minCapacity: 0 }, /minCapacity must be a positive integer/],
    [{ ...normalScalingSnapshot(), oldTaskDefinition: '' }, /oldTaskDefinition is required/],
    [
      {
        ...normalScalingSnapshot(),
        suspendedState: { ...normalScalingSnapshot().suspendedState, DynamicScalingOutSuspended: 'false' },
      },
      /DynamicScalingOutSuspended must be a boolean/,
    ],
    [
      Object.fromEntries(Object.entries(normalScalingSnapshot()).filter(([field]) => field !== 'serviceName')),
      /fields are invalid/,
    ],
  ]

  for (const [snapshot, pattern] of cases) {
    assert.throws(() => validateBillingOutboxScalingSnapshot(snapshot, state, EXPECTED_API_IMAGE), pattern)
  }
})

test('keeps scaling fenced while one verified new Api task starts, then restores the exact snapshot', async () => {
  const fixture = createDeployFixture()
  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  fixture.installNewTaskDefinition()

  const deployed = verifyBillingOutboxDeploymentWhileDrained({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    awsJson: fixture.awsJson,
  })
  assert.equal(deployed.taskDefinition, NEW_TASK_DEFINITION)

  await startBillingOutboxApiForVerification({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    deployedTaskDefinition: deployed.taskDefinition,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  assert.equal(fixture.state.desiredCount, 1)
  assert.equal(fixture.state.runningCount, 1)
  assert.equal(fixture.state.minCapacity, 0)
  assert.deepEqual(fixture.state.suspendedState, FULLY_SUSPENDED)

  await restoreBillingOutboxScaling({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    deployedTaskDefinition: deployed.taskDefinition,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  assert.equal(fixture.state.minCapacity, 1)
  assert.equal(fixture.state.maxCapacity, 4)
  assert.deepEqual(fixture.state.suspendedState, normalScalingSnapshot().suspendedState)
  assert.equal(fixture.parameters.has(MARKER_NAME), false, 'only the wrapper may record after public verification')
})

test('starts one verification task but restores any stable positive original capacity', async () => {
  const fixture = createDeployFixture()
  fixture.state.desiredCount = 3
  fixture.state.runningCount = 3
  fixture.state.minCapacity = 2
  fixture.state.maxCapacity = 7

  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  assert.equal(context.snapshot.desiredCount, 3)
  assert.equal(context.snapshot.minCapacity, 2)
  assert.equal(context.snapshot.maxCapacity, 7)

  fixture.installNewTaskDefinition()
  const deployed = verifyBillingOutboxDeploymentWhileDrained({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    awsJson: fixture.awsJson,
  })
  await startBillingOutboxApiForVerification({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    deployedTaskDefinition: deployed.taskDefinition,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  assert.equal(fixture.state.desiredCount, 1)
  assert.equal(fixture.state.minCapacity, 0)
  assert.deepEqual(fixture.state.suspendedState, FULLY_SUSPENDED)

  await restoreBillingOutboxScaling({
    stage: 'dev',
    region: 'ap-southeast-1',
    context,
    deployedTaskDefinition: deployed.taskDefinition,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })
  assert.equal(fixture.state.desiredCount, 3)
  assert.equal(fixture.state.runningCount, 3)
  assert.equal(fixture.state.minCapacity, 2)
  assert.equal(fixture.state.maxCapacity, 7)
})

test('rejects an unchanged or wrong-image task definition while Api is drained', async () => {
  const fixture = createDeployFixture()
  const context = await prepareBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    image: EXPECTED_API_IMAGE,
    awsJson: fixture.awsJson,
    awsWait: fixture.awsWait,
  })

  assert.throws(
    () =>
      verifyBillingOutboxDeploymentWhileDrained({
        stage: 'dev',
        region: 'ap-southeast-1',
        context,
        awsJson: fixture.awsJson,
      }),
    /did not replace the old Api task definition/,
  )

  fixture.installNewTaskDefinition()
  assert.throws(
    () =>
      verifyBillingOutboxDeploymentWhileDrained({
        stage: 'dev',
        region: 'ap-southeast-1',
        context: { ...context, selectedImage: RELEASE_API_IMAGE },
        awsJson: fixture.awsJson,
      }),
    /not the exact repository and tag/,
  )
})

test('a partial fencing failure still attempts desired zero and fails closed', async () => {
  const fixture = createDeployFixture({ snapshot: normalScalingSnapshot(), initiallyFenced: true })
  fixture.state.desiredCount = 1
  fixture.state.runningCount = 1
  fixture.failOnce('application-autoscaling register-scalable-target')

  await assert.rejects(
    fenceBillingOutboxApi({
      stage: 'dev',
      region: 'ap-southeast-1',
      snapshot: normalScalingSnapshot(),
      awsJson: fixture.awsJson,
      awsWait: fixture.awsWait,
    }),
    /failed to establish the billing outbox Api cutover fence/,
  )
  assert.equal(fixture.state.desiredCount, 0)
  assert.equal(
    fixture.calls.some((args) => args[0] === 'ecs' && args[1] === 'update-service'),
    true,
  )
})

test('writes only the boolean marker decision to GitHub outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-outbox-cutover-'))
  const outputPath = join(directory, 'github-output')
  try {
    writePreflightOutput(outputPath, true)
    writePreflightOutput(outputPath, false)
    assert.equal(readFileSync(outputPath, 'utf8'), 'marker_required=true\nmarker_required=false\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the checked-out deploy wrapper owns the cutover so main’s older workflow is safe', () => {
  const source = readFileSync(DEPLOY_WORKFLOW, 'utf8')
  const workflow = load(source)
  const steps = workflow.jobs.deploy.steps
  const preview = steps.find((step) => step.name === 'Preview the full stack')
  const deploy = steps.find((step) => step.name === 'Deploy the full stack')
  const cleanup = steps.find((step) => step.name === 'Remove materialized configuration')

  assert.ok(preview && deploy && cleanup)
  assert.equal(preview.if, undefined, 'preview-only runs must not evaluate the cutover gate')
  assert.equal(deploy.if, '${{ inputs.apply }}')
  assert.equal(deploy.run, 'npm run deploy -- --stage "$STAGE" --policy .')
  assert.equal(
    steps.some((step) => step.name === 'Enforce billing outbox cutover drain'),
    false,
  )
  assert.equal(
    steps.some((step) => step.name === 'Record billing outbox cutover'),
    false,
  )
  assert.ok(steps.indexOf(preview) < steps.indexOf(deploy))
  assert.ok(steps.indexOf(deploy) < steps.indexOf(cleanup))

  const wrapper = readFileSync(SST_WRAPPER, 'utf8')
  const prepare = wrapper.indexOf('await prepareBillingOutboxCutover(')
  const runSst = wrapper.indexOf('await withPulumiEventLogCleanup(')
  const verifyDrained = wrapper.indexOf('verifyBillingOutboxDeploymentWhileDrained({')
  const startOne = wrapper.indexOf('await startBillingOutboxApiForVerification({')
  const verifyPublic = wrapper.indexOf('await verifyPublicDeploymentWithRetry(publicDeploymentConfig')
  const restore = wrapper.indexOf('await restoreBillingOutboxScaling({')
  const record = wrapper.indexOf('recordBillingOutboxCutover({')
  const failureFence = wrapper.indexOf('if (billingOutboxCutover?.required && !billingOutboxCutoverComplete)')

  for (const index of [prepare, runSst, verifyDrained, startOne, verifyPublic, restore, record, failureFence]) {
    assert.notEqual(index, -1)
  }
  assert.ok(prepare < runSst)
  assert.ok(runSst < verifyDrained)
  assert.ok(verifyDrained < startOne)
  assert.ok(startOne < verifyPublic)
  assert.ok(verifyPublic < restore)
  assert.ok(restore < record)
  assert.ok(record < failureFence)
  assert.match(wrapper, new RegExp(`process\\.env\\[BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE_ENV\\] =`))
  assert.match(wrapper, new RegExp(`delete process\\.env\\[BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE_ENV\\]`))
  assert.match(wrapper, /image: selectedApiImageReference/)
  assert.match(wrapper, /await fenceBillingOutboxApi\(/)

  const releaseWorkflow = load(readFileSync(RELEASE_DEPLOY_WORKFLOW, 'utf8'))
  assert.equal(workflow.concurrency.group, 'deploy-${{ inputs.stage }}-stack')
  assert.equal(releaseWorkflow.concurrency.group, workflow.concurrency.group)
  assert.equal(BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE_ENV, 'BOXLITE_INTERNAL_BILLING_OUTBOX_DRAINED_DEPLOY_IMAGE')
})
