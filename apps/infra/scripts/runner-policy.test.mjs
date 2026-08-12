// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import runnerInventory from './runner-inventory.cjs'
import runnerStateBaseline from './runner-state-baseline.cjs'
import runnerPolicyDefinitions from '../policies/runner/definitions.cjs'
import runnerPolicy from '../policies/runner/validate.cjs'

const { CONTROL_PLANE_NAME_TAG, extraRunnerInstanceProfileName, resolveRunnerInventory } = runnerInventory
const {
  createRunnerIdentityFingerprint,
  createRunnerProfileMigrationFingerprint,
  createRunnerSafetyFingerprint,
} = runnerStateBaseline
const { createRunnerPolicies } = runnerPolicyDefinitions
const { validateRunnerResource, validateRunnerStack } = runnerPolicy
const RUNNER_TYPE = 'aws:ec2/instance:Instance'
const SAFE_OPTIONS = { protect: true, ignoreChanges: ['ami', 'userDataBase64'] }
const SENSITIVE_PROPERTY_VALUE = 'sentinel-sensitive-user-data'
const RUNNER_POLICY_ENTRY = fileURLToPath(new URL('../policies/runner/index.js', import.meta.url))
const SAFE_RUNNER_PROPERTIES = {
  associatePublicIpAddress: true,
  cpuOptions: { nestedVirtualization: 'enabled' },
  iamInstanceProfile: 'boxlite-dev-runner-profile',
  instanceType: 'c8i.2xlarge',
  metadataOptions: { httpEndpoint: 'enabled', httpPutResponseHopLimit: 1, httpTokens: 'required' },
  rootBlockDevice: { volumeSize: 100 },
  subnetId: 'subnet-123',
  vpcSecurityGroupIds: ['sg-456'],
}

function runnerResource(spec, overrides = {}) {
  return {
    type: RUNNER_TYPE,
    name: spec.resourceName,
    props: {
      ...SAFE_RUNNER_PROPERTIES,
      userDataBase64: SENSITIVE_PROPERTY_VALUE,
      tags: {
        Name: spec.nameTag,
        [CONTROL_PLANE_NAME_TAG]: spec.controlPlaneRunnerName,
        'boxlite:stage': 'dev',
        'boxlite:ssm-role': 'runner',
      },
    },
    opts: SAFE_OPTIONS,
    ...overrides,
  }
}

function runnerBaseline(inventory, includedInventory = inventory) {
  const includedNames = new Set(includedInventory.map((runner) => runner.resourceName))
  return {
    version: 4,
    stage: 'dev',
    resources: Object.fromEntries(
      inventory
        .filter((runner) => includedNames.has(runner.resourceName))
        .map((runner) => [
          runner.resourceName,
          {
            instanceId: `i-${String(inventory.indexOf(runner) + 1).padStart(17, '0')}`,
            inputFingerprint: createRunnerSafetyFingerprint(runnerResource(runner).props),
            identityFingerprint: createRunnerIdentityFingerprint(runnerResource(runner).props, runner.resourceName),
            profileMigrationFingerprint: createRunnerProfileMigrationFingerprint(runnerResource(runner).props),
          },
        ]),
    ),
  }
}

function collectViolations(validate) {
  const violations = []
  validate((message) => violations.push(message))
  return violations
}

test('requires the serialized Runner state baseline before loading the policy pack', () => {
  const environment = { ...process.env }
  delete environment.DEFAULT_RUNNER_NAME
  delete environment.BOXLITE_RUNNER_STATE_BASELINE
  delete environment.RUNNERS

  const result = spawnSync(process.execPath, [RUNNER_POLICY_ENTRY], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BOXLITE_RUNNER_STATE_BASELINE is required/)
})

test('requires a Runner state baseline when creating policy definitions', () => {
  assert.throws(() => createRunnerPolicies(resolveRunnerInventory({})), /Runner state baseline is required/)
})

test('accepts protected Runner resources with exact lifecycle, identity, and state', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2', DEFAULT_RUNNER_NAME: 'primary' })
  const baseline = runnerBaseline(inventory)

  for (const spec of inventory) {
    assert.deepEqual(validateRunnerResource(runnerResource(spec), inventory, baseline), [])
    assert.deepEqual(
      validateRunnerResource(
        runnerResource(spec, { opts: { protect: true, ignoreChanges: ['userDataBase64', 'ami'] } }),
        inventory,
        baseline,
      ),
      [],
    )
  }
  assert.deepEqual(
    validateRunnerResource(
      {
        type: RUNNER_TYPE,
        name: 'Worker',
        props: { tags: { Name: 'unrelated-instance' } },
        opts: {},
      },
      inventory,
      baseline,
    ),
    [],
  )
})

test('rejects missing or changed Runner stage and role tags', () => {
  const inventory = resolveRunnerInventory({})
  const baseline = runnerBaseline(inventory)
  const [spec] = inventory
  const missingStage = runnerResource(spec)
  delete missingStage.props.tags['boxlite:stage']
  const wrongStage = runnerResource(spec)
  wrongStage.props.tags['boxlite:stage'] = 'prod'
  const wrongRole = runnerResource(spec)
  wrongRole.props.tags['boxlite:ssm-role'] = 'api'

  for (const resource of [missingStage, wrongStage, wrongRole]) {
    assert.deepEqual(validateRunnerResource(resource, inventory, baseline), [
      'Runner identity tags must match the deployment inventory.',
    ])
  }
})

// An untagged resource compared against a baseline that carries no stage must
// not satisfy the stage assertion by matching undefined against undefined.
test('rejects an untagged Runner stage even when the baseline carries no stage', () => {
  const inventory = resolveRunnerInventory({})
  const [spec] = inventory
  const missingStage = runnerResource(spec)
  delete missingStage.props.tags['boxlite:stage']

  for (const baseline of [undefined, { version: 4, resources: {} }, { version: 4, stage: '', resources: {} }]) {
    assert.ok(
      validateRunnerResource(missingStage, inventory, baseline).includes(
        'Runner identity tags must match the deployment inventory.',
      ),
      'a stage-less baseline must not vacuously satisfy the stage assertion',
    )
  }
})

test('rejects unsafe Runner lifecycle options without reporting property values', () => {
  const inventory = resolveRunnerInventory({})
  const baseline = runnerBaseline(inventory)
  const [spec] = inventory
  const cases = [
    {
      resource: runnerResource(spec, { opts: { ...SAFE_OPTIONS, protect: false } }),
      expected: ['Runner resources must keep deletion protection enabled.'],
    },
    {
      resource: runnerResource(spec, { opts: { protect: true, ignoreChanges: ['ami'] } }),
      expected: ['Runner resources must ignore only AMI and user-data changes.'],
    },
    {
      resource: runnerResource(spec, {
        opts: { protect: true, ignoreChanges: [...SAFE_OPTIONS.ignoreChanges, 'instanceType'] },
      }),
      expected: ['Runner resources must ignore only AMI and user-data changes.'],
    },
    {
      resource: runnerResource(spec, {
        opts: { protect: true, ignoreChanges: ['ami', 'userDataBase64', 'userDataBase64'] },
      }),
      expected: ['Runner resources must ignore only AMI and user-data changes.'],
    },
  ]

  for (const { resource, expected } of cases) {
    const violations = validateRunnerResource(resource, inventory, baseline)
    assert.deepEqual(violations, expected)
    assert.doesNotMatch(violations.join('\n'), new RegExp(SENSITIVE_PROPERTY_VALUE))
  }
})

test('rejects missing, mismatched, or unexpected Runner identities', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2', DEFAULT_RUNNER_NAME: 'primary' })
  const baseline = runnerBaseline(inventory)
  const [defaultRunner, extraRunner] = inventory
  const missingIdentityTag = runnerResource(defaultRunner)
  delete missingIdentityTag.props.tags[CONTROL_PLANE_NAME_TAG]
  const mismatchedNameTag = runnerResource(extraRunner)
  mismatchedNameTag.props.tags.Name = 'boxlite-runner-9'
  const cases = [
    missingIdentityTag,
    mismatchedNameTag,
    runnerResource(defaultRunner, { type: 'aws:ec2/launchTemplate:LaunchTemplate' }),
    {
      type: RUNNER_TYPE,
      name: 'Canary',
      props: { tags: { Name: 'boxlite-runner-canary' } },
      opts: SAFE_OPTIONS,
    },
    {
      type: RUNNER_TYPE,
      name: 'Runner-runner-3',
      props: { tags: {} },
      opts: SAFE_OPTIONS,
    },
  ]

  assert.deepEqual(validateRunnerResource(cases[0], inventory, baseline), [
    'Runner identity tags must match the deployment inventory.',
  ])
  assert.deepEqual(validateRunnerResource(cases[1], inventory, baseline), [
    'Runner identity tags must match the deployment inventory.',
  ])
  assert.deepEqual(validateRunnerResource(cases[2], inventory, baseline), [
    'Runner resources must remain EC2 instances.',
  ])
  assert.deepEqual(validateRunnerResource(cases[3], inventory, baseline), [
    'Runner identity is not declared by the deployment inventory.',
  ])
  assert.deepEqual(validateRunnerResource(cases[4], inventory, baseline), [
    'Runner identity is not declared by the deployment inventory.',
  ])
})

test('rejects a deployment-config rename of an existing Runner identity', () => {
  const currentInventory = resolveRunnerInventory({ DEFAULT_RUNNER_NAME: 'current-name' })
  const desiredInventory = resolveRunnerInventory({ DEFAULT_RUNNER_NAME: 'renamed' })
  const baseline = runnerBaseline(currentInventory)

  assert.ok(
    validateRunnerResource(runnerResource(desiredInventory[0]), desiredInventory, baseline).includes(
      'Runner identity tags must match the current deployment state.',
    ),
  )
})

test('rejects incomplete or ambiguous Runner stacks', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2', DEFAULT_RUNNER_NAME: 'primary' })
  const baseline = runnerBaseline(inventory)
  const resources = inventory.map((spec) => runnerResource(spec))

  assert.deepEqual(validateRunnerStack(resources, inventory, baseline), [])
  assert.deepEqual(validateRunnerStack(resources.slice(0, 1), inventory, baseline), [
    'Runner inventory is missing a declared resource.',
  ])
  assert.deepEqual(validateRunnerStack([...resources, runnerResource(inventory[1])], inventory, baseline), [
    'Runner inventory contains a duplicate declared resource.',
  ])
  assert.deepEqual(
    validateRunnerStack(
      [
        ...resources,
        {
          type: RUNNER_TYPE,
          name: 'Canary',
          props: { tags: { Name: 'boxlite-runner-canary' } },
          opts: SAFE_OPTIONS,
        },
      ],
      inventory,
      baseline,
    ),
    ['Runner inventory contains an undeclared resource.'],
  )
})

test('ignores unresolved properties on unrelated resources without weakening inventory checks', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2' })
  const baseline = runnerBaseline(inventory)
  const unrelatedResource = {
    type: RUNNER_TYPE,
    name: 'VpcNatInstance',
    props: new Proxy(
      {},
      {
        get() {
          throw new Error('property value is unknown during preview')
        },
      },
    ),
    opts: {},
  }

  assert.deepEqual(validateRunnerResource(unrelatedResource, inventory, baseline), [])
  assert.deepEqual(validateRunnerStack([runnerResource(inventory[0]), unrelatedResource], inventory, baseline), [
    'Runner inventory is missing a declared resource.',
  ])
})

test('rejects protected Runner property drift even when no preview event is available', () => {
  const inventory = resolveRunnerInventory({})
  const baseline = runnerBaseline(inventory)
  const [spec] = inventory

  for (const changedProperties of [
    { instanceType: 'c8i.4xlarge' },
    { subnetId: 'subnet-other' },
    { vpcSecurityGroupIds: ['sg-other'] },
    { iamInstanceProfile: 'other-profile' },
    { rootBlockDevice: { volumeSize: 200 } },
    { metadataOptions: { httpEndpoint: 'enabled', httpPutResponseHopLimit: 2, httpTokens: 'required' } },
    { cpuOptions: { nestedVirtualization: 'disabled' } },
    { associatePublicIpAddress: false },
    { rootBlockDevice: { volumeSize: 100, encrypted: false } },
    { disableApiTermination: true },
  ]) {
    const resource = runnerResource(spec)
    resource.props = { ...resource.props, ...changedProperties }
    assert.ok(
      validateRunnerResource(resource, inventory, baseline).includes(
        'Runner protected properties must match the current deployment state.',
      ),
    )
  }
})

test('allows only extra Runners one in-place migration to their exact stage-bound profile', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2' })
  const baseline = runnerBaseline(inventory)
  const [defaultRunner, extraRunner] = inventory
  const targetProfile = extraRunnerInstanceProfileName('dev')
  const migratedExtra = runnerResource(extraRunner)
  migratedExtra.props.iamInstanceProfile = targetProfile

  assert.deepEqual(validateRunnerResource(migratedExtra, inventory, baseline), [])

  const wrongProfile = runnerResource(extraRunner)
  wrongProfile.props.iamInstanceProfile = extraRunnerInstanceProfileName('prod')
  assert.ok(
    validateRunnerResource(wrongProfile, inventory, baseline).includes(
      'Runner protected properties must match the current deployment state.',
    ),
  )

  const changedAlongsideProfile = runnerResource(extraRunner)
  changedAlongsideProfile.props.iamInstanceProfile = targetProfile
  changedAlongsideProfile.props.instanceType = 'c8i.4xlarge'
  assert.ok(
    validateRunnerResource(changedAlongsideProfile, inventory, baseline).includes(
      'Runner protected properties must match the current deployment state.',
    ),
  )

  const defaultWithExtraProfile = runnerResource(defaultRunner)
  defaultWithExtraProfile.props.iamInstanceProfile = targetProfile
  assert.ok(
    validateRunnerResource(defaultWithExtraProfile, inventory, baseline).includes(
      'Runner protected properties must match the current deployment state.',
    ),
  )
})

test('rejects a currently missing Runner in routine deployments', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2' })
  const baseline = runnerBaseline(inventory, inventory.slice(0, 1))
  const resources = inventory.map((spec) => runnerResource(spec))

  assert.ok(
    validateRunnerResource(resources[1], inventory, baseline).includes(
      'Routine deployment must not create a Runner resource.',
    ),
  )
  assert.ok(
    validateRunnerStack(resources, inventory, baseline).includes(
      'Runner inventory differs from the current deployment state.',
    ),
  )
})

test('rejects Runner properties that cannot be resolved during preview', () => {
  const inventory = resolveRunnerInventory({})
  const baseline = runnerBaseline(inventory)
  const resource = runnerResource(inventory[0])
  resource.props.subnetId = new Proxy(
    {},
    {
      get() {
        throw new Error('property value is unknown during preview')
      },
    },
  )

  assert.ok(
    validateRunnerResource(resource, inventory, baseline).includes(
      'Runner protected properties could not be resolved for comparison.',
    ),
  )
})

test('reports unresolved Runner identity-tag properties as policy violations', () => {
  const inventory = resolveRunnerInventory({})
  const baseline = runnerBaseline(inventory)
  const resource = runnerResource(inventory[0])
  resource.props.tags = new Proxy(resource.props.tags, {
    get() {
      throw new Error('tag value is unknown during preview')
    },
  })

  const violations = validateRunnerResource(resource, inventory, baseline)
  assert.ok(violations.includes('Runner identity tags must match the deployment inventory.'))
})

test('wires mandatory resource and stack validators to policy reports', () => {
  const inventory = resolveRunnerInventory({ RUNNERS: '2' })
  const baseline = runnerBaseline(inventory)
  const policies = createRunnerPolicies(inventory, baseline)
  assert.deepEqual(
    policies.map(({ name, enforcementLevel }) => ({ name, enforcementLevel })),
    [
      { name: 'runner-instance-contract', enforcementLevel: 'mandatory' },
      { name: 'runner-inventory-complete', enforcementLevel: 'mandatory' },
    ],
  )

  const resourcePolicy = policies[0]
  const stackPolicy = policies[1]
  assert.deepEqual(
    collectViolations((reportViolation) =>
      resourcePolicy.validateResource(
        runnerResource(inventory[0], { opts: { ...SAFE_OPTIONS, protect: false } }),
        reportViolation,
      ),
    ),
    ['Runner resources must keep deletion protection enabled.'],
  )
  assert.deepEqual(
    collectViolations((reportViolation) =>
      stackPolicy.validateStack({ resources: [runnerResource(inventory[0])] }, reportViolation),
    ),
    ['Runner inventory is missing a declared resource.'],
  )
})
