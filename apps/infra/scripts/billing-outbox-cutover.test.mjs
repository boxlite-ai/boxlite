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
  BILLING_OUTBOX_MIGRATION_ID,
  assertApiServiceIsDrained,
  billingOutboxCutoverMarkerName,
  preflightBillingOutboxCutover,
  readBillingOutboxCutoverMarker,
  recordBillingOutboxCutover,
  writePreflightOutput,
} from './billing-outbox-cutover.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-infra.yml')
const SST_WRAPPER = join(REPO_ROOT, 'apps/infra/scripts/sst-with-cloudflare.mjs')
const CLUSTER_ARN = 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/boxlite-dev-cluster'
const SCALABLE_TARGET_RESOURCE_ID = 'service/boxlite-dev-cluster/Api'
const SERVICE_ARN = 'arn:aws:ecs:ap-southeast-1:123456789012:service/boxlite-dev-cluster/Api'
const MARKER_NAME = `/boxlite/dev/migrations/${BILLING_OUTBOX_MIGRATION_ID}`
const SELECTED_REF = '0123456789abcdef0123456789abcdef01234567'

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

test('builds the stage-scoped String marker name and rejects path injection', () => {
  assert.equal(billingOutboxCutoverMarkerName('dev'), MARKER_NAME)
  assert.throws(() => billingOutboxCutoverMarkerName('../prod'), /unsupported characters/)
})

test('an existing String marker allows a normal deploy without inspecting ECS', () => {
  const fixture = createAwsFixture({
    'ssm get-parameter': {
      Parameter: { Name: MARKER_NAME, Type: 'String', Value: SELECTED_REF },
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

test('rejects a non-String or empty marker instead of treating it as complete', () => {
  for (const parameter of [
    { Name: MARKER_NAME, Type: 'SecureString', Value: SELECTED_REF },
    { Name: MARKER_NAME, Type: 'String', Value: '' },
  ]) {
    const fixture = createAwsFixture({ 'ssm get-parameter': { Parameter: parameter } })
    assert.throws(
      () =>
        readBillingOutboxCutoverMarker({
          stage: 'dev',
          region: 'ap-southeast-1',
          awsJson: fixture.awsJson,
        }),
      /must be an SSM String|is empty/,
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
      pattern: /expected exactly one, found 0/,
    },
    {
      overrides: { 'ecs describe-services': { failures: [{ reason: 'MISSING' }], services: [] } },
      pattern: /reported 1 failure/,
    },
    {
      overrides: {
        'ecs describe-services': {
          failures: [],
          services: [{ serviceArn: SERVICE_ARN, serviceName: 'Api', desiredCount: 0, runningCount: 0 }],
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

test('records the selected full SHA as a String marker without returning its value', () => {
  const fixture = createAwsFixture()

  const result = recordBillingOutboxCutover({
    stage: 'dev',
    region: 'ap-southeast-1',
    ref: SELECTED_REF,
    awsJson: fixture.awsJson,
  })

  assert.deepEqual(result, { markerName: MARKER_NAME })
  assert.deepEqual(fixture.calls, [
    ['ssm', 'put-parameter', '--name', MARKER_NAME, '--type', 'String', '--value', SELECTED_REF, '--overwrite'],
  ])
  assert.throws(
    () =>
      recordBillingOutboxCutover({
        stage: 'dev',
        region: 'ap-southeast-1',
        ref: 'main',
        awsJson: fixture.awsJson,
      }),
    /full lowercase Git SHA/,
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

test('workflow gates apply after preview and records completion only after verified deploy success', () => {
  const source = readFileSync(DEPLOY_WORKFLOW, 'utf8')
  const workflow = load(source)
  const steps = workflow.jobs.deploy.steps
  const preview = steps.find((step) => step.name === 'Preview the full stack')
  const preflight = steps.find((step) => step.name === 'Enforce billing outbox cutover drain')
  const deploy = steps.find((step) => step.name === 'Deploy the full stack')
  const record = steps.find((step) => step.name === 'Record billing outbox cutover')
  const cleanup = steps.find((step) => step.name === 'Remove materialized configuration')

  assert.ok(preview && preflight && deploy && record && cleanup)
  assert.equal(preview.if, undefined, 'preview-only runs must not evaluate the cutover gate')
  assert.equal(preflight.id, 'outbox_cutover')
  assert.equal(preflight.if, '${{ inputs.apply }}')
  assert.match(preflight.run, /billing-outbox-cutover\.mjs preflight/)
  assert.match(preflight.run, /--app boxlite/)
  assert.match(preflight.run, /--github-output "\$GITHUB_OUTPUT"/)
  assert.equal(preflight['continue-on-error'], undefined)
  assert.equal(deploy.if, '${{ inputs.apply }}')
  assert.equal(deploy.run, 'npm run deploy -- --stage "$STAGE" --policy .')
  assert.equal(record.if, "${{ success() && inputs.apply && steps.outbox_cutover.outputs.marker_required == 'true' }}")
  assert.match(record.run, /billing-outbox-cutover\.mjs record/)
  assert.match(record.run, /--ref "\$BOXLITE_ARTIFACT_REF"/)
  assert.equal(record['continue-on-error'], undefined)

  assert.ok(steps.indexOf(preview) < steps.indexOf(preflight), 'preview must complete before the apply-only gate')
  assert.ok(steps.indexOf(preflight) < steps.indexOf(deploy), 'the drain gate must run before SST deploy')
  assert.ok(
    steps.indexOf(deploy) < steps.indexOf(record),
    'the marker must be written only after deploy returns success',
  )
  assert.ok(steps.indexOf(record) < steps.indexOf(cleanup), 'configuration cleanup must remain the final always step')

  const wrapper = readFileSync(SST_WRAPPER, 'utf8')
  assert.match(wrapper, /verifyPublicDeploymentWithRetry\(publicDeploymentConfig/)
  assert.ok(
    wrapper.indexOf('verifyPublicDeploymentWithRetry(publicDeploymentConfig') <
      wrapper.lastIndexOf('process.exit(exitCode)'),
    'the deploy command must return success only after public API verification',
  )
})
