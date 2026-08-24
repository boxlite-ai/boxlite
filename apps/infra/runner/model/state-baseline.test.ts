// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import runnerStateBaseline from './state-baseline.js'

const {
  createRunnerIdentityFingerprint,
  createRunnerSafetyFingerprint,
  createRunnerStateBaseline,
  parseRunnerStateBaseline,
} = runnerStateBaseline
const SENSITIVE_VALUE = 'sentinel-secret-that-must-not-leave-the-checkpoint'

function runnerInputs(overrides = {}) {
  return {
    ami: SENSITIVE_VALUE,
    associatePublicIpAddress: true,
    cpuOptions: { nestedVirtualization: 'enabled' },
    iamInstanceProfile: 'boxlite-dev-runner-profile',
    instanceType: 'c8i.2xlarge',
    metadataOptions: { httpEndpoint: 'enabled', httpPutResponseHopLimit: 1, httpTokens: 'required' },
    rootBlockDevice: { deleteOnTermination: true, volumeSize: 100 },
    subnetId: 'subnet-123',
    tags: { Name: 'boxlite-runner-default', secret: SENSITIVE_VALUE },
    tagsAll: { Name: 'boxlite-runner-default', secret: SENSITIVE_VALUE },
    userDataBase64: SENSITIVE_VALUE,
    vpcSecurityGroupIds: ['sg-456'],
    futureProviderInput: SENSITIVE_VALUE,
    ...overrides,
  }
}

function exportedState(resources: any) {
  return { stack: 'dev', latest: { resources } }
}

function runnerStateResource(name = 'Runner', overrides = {}) {
  return {
    urn: `urn:pulumi:dev::boxlite::aws:ec2/instance:Instance::${name}`,
    type: 'aws:ec2/instance:Instance',
    custom: true,
    id: 'i-runner',
    inputs: runnerInputs(),
    outputs: { passwordData: SENSITIVE_VALUE },
    provider: 'urn:pulumi:dev::boxlite::pulumi:providers:aws::AwsProvider::provider-id',
    protect: true,
    ignoreChanges: ['ami', 'userDataBase64'],
    ...overrides,
  }
}

test('reduces SST state to non-secret Runner safety properties', () => {
  const baseline = createRunnerStateBaseline(
    exportedState([
      runnerStateResource(),
      {
        urn: 'urn:pulumi:dev::boxlite::aws:ecs/service:Service::ApiService',
        type: 'aws:ecs/service:Service',
        inputs: { secret: SENSITIVE_VALUE },
      },
    ]),
  )

  assert.deepEqual(baseline, {
    version: 3,
    resources: {
      Runner: {
        inputFingerprint: createRunnerSafetyFingerprint(runnerInputs()),
        identityFingerprint: createRunnerIdentityFingerprint(runnerInputs(), 'Runner', {
          allowLegacyFallback: true,
        }),
      },
    },
  })
  const serialized = JSON.stringify(baseline)
  assert.doesNotMatch(serialized, new RegExp(SENSITIVE_VALUE))
  assert.deepEqual(parseRunnerStateBaseline(serialized), baseline)
})

test('locks legacy and current Runner identity tags to one state fingerprint', () => {
  const legacyInputs = runnerInputs()
  const taggedInputs = runnerInputs({
    tags: { Name: 'boxlite-runner-default', 'boxlite:control-plane-runner-name': 'default' },
    tagsAll: { Name: 'boxlite-runner-default', 'boxlite:control-plane-runner-name': 'default' },
  })
  const renamedInputs = runnerInputs({
    tags: { Name: 'boxlite-runner-default', 'boxlite:control-plane-runner-name': 'renamed' },
  })

  assert.equal(
    createRunnerIdentityFingerprint(legacyInputs, 'Runner', { allowLegacyFallback: true }),
    createRunnerIdentityFingerprint(taggedInputs, 'Runner'),
  )
  assert.notEqual(
    createRunnerIdentityFingerprint(taggedInputs, 'Runner'),
    createRunnerIdentityFingerprint(renamedInputs, 'Runner'),
  )
  assert.throws(() => createRunnerIdentityFingerprint(legacyInputs, 'Runner'), /control-plane identity tag/)
})

test('hashes every explicit input while ignoring provider defaults and approved mutable inputs', () => {
  const currentInputs = runnerInputs({
    __defaults: ['forceDestroy', 'getPasswordData', 'sourceDestCheck', 'userDataReplaceOnChange'],
    forceDestroy: false,
    getPasswordData: false,
    sourceDestCheck: true,
    userDataReplaceOnChange: false,
    metadataOptions: {
      __defaults: ['httpProtocolIpv6'],
      httpEndpoint: 'enabled',
      httpProtocolIpv6: 'disabled',
      httpPutResponseHopLimit: 1,
      httpTokens: 'required',
    },
    rootBlockDevice: {
      __defaults: ['deleteOnTermination'],
      deleteOnTermination: true,
      volumeSize: 100,
    },
  })
  const equivalentDesiredInputs = runnerInputs({ rootBlockDevice: { volumeSize: 100 } })
  const providerExpandedDesiredInputs = runnerInputs({
    forceDestroy: false,
    getPasswordData: false,
    sourceDestCheck: true,
    userDataReplaceOnChange: false,
    metadataOptions: {
      httpEndpoint: 'enabled',
      httpProtocolIpv6: 'disabled',
      httpPutResponseHopLimit: 1,
      httpTokens: 'required',
    },
    rootBlockDevice: { deleteOnTermination: true, volumeSize: 100 },
  })
  const changedExplicitInput = runnerInputs({ sourceDestCheck: false, rootBlockDevice: { volumeSize: 100 } })
  const changedMutableInputs = runnerInputs({
    ami: 'different-ami',
    tags: { Name: 'different-name' },
    tagsAll: { Name: 'different-name' },
    userDataBase64: 'different-user-data',
  })

  assert.equal(createRunnerSafetyFingerprint(currentInputs), createRunnerSafetyFingerprint(equivalentDesiredInputs))
  assert.equal(
    createRunnerSafetyFingerprint(currentInputs),
    createRunnerSafetyFingerprint(providerExpandedDesiredInputs),
  )
  assert.notEqual(createRunnerSafetyFingerprint(currentInputs), createRunnerSafetyFingerprint(changedExplicitInput))
  assert.equal(createRunnerSafetyFingerprint(runnerInputs()), createRunnerSafetyFingerprint(changedMutableInputs))
  assert.equal(
    createRunnerSafetyFingerprint(runnerInputs({ vpcSecurityGroupIds: ['sg-b', 'sg-a'] })),
    createRunnerSafetyFingerprint(runnerInputs({ vpcSecurityGroupIds: ['sg-a', 'sg-b'] })),
  )
  assert.notEqual(
    createRunnerSafetyFingerprint(runnerInputs({ networkInterfaces: [{ deviceIndex: 0 }, { deviceIndex: 1 }] })),
    createRunnerSafetyFingerprint(runnerInputs({ networkInterfaces: [{ deviceIndex: 1 }, { deviceIndex: 0 }] })),
  )
  assert.throws(
    () => createRunnerSafetyFingerprint(runnerInputs({ __defaults: ['sourceDestCheck'], sourceDestCheck: false })),
    /provider default/,
  )
})

test('ignores approved mutable inputs recorded in provider defaults metadata', () => {
  assert.equal(
    createRunnerSafetyFingerprint(
      runnerInputs({
        __defaults: ['ami', 'tags', 'tagsAll', 'userDataBase64', 'sourceDestCheck'],
        sourceDestCheck: true,
      }),
    ),
    createRunnerSafetyFingerprint(runnerInputs()),
  )
})

test('rejects malformed, duplicate, unexpected, or unprotected Runner state', () => {
  assert.throws(() => createRunnerStateBaseline({}), /SST state export/)
  assert.throws(
    () => createRunnerStateBaseline(exportedState([runnerStateResource(), runnerStateResource()])),
    /duplicate Runner resource/,
  )
  assert.throws(
    () => createRunnerStateBaseline(exportedState([runnerStateResource('Canary')])),
    /unexpected Runner-like resource/,
  )
  assert.throws(
    () =>
      createRunnerStateBaseline(
        exportedState([runnerStateResource('Runner-runner-0', { inputs: runnerInputs({ tags: {}, tagsAll: {} }) })]),
      ),
    /unexpected Runner-like resource/,
  )
  assert.throws(
    () =>
      createRunnerStateBaseline(
        exportedState([runnerStateResource('Runner', { type: 'aws:ec2/launchTemplate:LaunchTemplate' })]),
      ),
    /unexpected Runner-like resource/,
  )
  assert.throws(
    () => createRunnerStateBaseline(exportedState([runnerStateResource('Runner', { protect: false })])),
    /unsafe Runner lifecycle/,
  )
  assert.throws(
    () =>
      createRunnerStateBaseline({
        ...exportedState([runnerStateResource()]),
        latest: { resources: [runnerStateResource()], pending_operations: [{ type: 'creating' }] },
      }),
    /pending operations/,
  )
  for (const overrides of [
    { id: '' },
    { custom: false },
    { delete: true },
    { external: true },
    { pendingReplacement: true },
    { retainOnDelete: true },
    { initErrors: ['synthetic init error'] },
    { taint: true },
  ]) {
    assert.throws(
      () => createRunnerStateBaseline(exportedState([runnerStateResource('Runner', overrides)])),
      /incomplete or transitional Runner/,
    )
  }
  assert.throws(() => parseRunnerStateBaseline('not-json'), /Runner state baseline/)
  assert.throws(() => parseRunnerStateBaseline('{"version":1,"resources":{}}'), /Runner state baseline/)
  assert.throws(
    () =>
      createRunnerStateBaseline(
        exportedState([
          runnerStateResource('Runner', {
            inputs: runnerInputs({
              tags: { Name: 'boxlite-runner-default', 'boxlite:control-plane-runner-name': 'default' },
              tagsAll: { Name: 'boxlite-runner-default', 'boxlite:control-plane-runner-name': 'other' },
            }),
          }),
        ]),
      ),
    /invalid Runner inputs/,
  )
})
