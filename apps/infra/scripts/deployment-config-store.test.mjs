// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-southeast-1'
const STAGE = 'dev'
const CURRENT_PARAMETER = '/boxlite/dev/deploy-config/current'
const OPERATION_LOCK_PARAMETER = '/boxlite/dev/deployment-operation-lock'
const FIRST_LOCK_OWNER = '11111111-1111-4111-8111-111111111111'
const SECOND_LOCK_OWNER = '22222222-2222-4222-8222-222222222222'

const environment = {
  STACK_DOMAIN: 'dev.example.test',
  OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
  OIDC_AUDIENCE: 'boxlite-api',
}
const runtimeSecretGenerations = {
  adminApiKey: 'generated-pending',
  clickHouseReaderPassword: 'generated-pending',
  clickHouseWriterPassword: 'generated-pending',
  defaultRunnerApiKey: 'generated-pending',
  encryptionKey: 'generated-pending',
  encryptionSalt: 'generated-pending',
  ghcrPullToken: 'generated-pending',
  otelCollectorApiKey: 'generated-pending',
  otelExporterOtlpHeaders: 'generated-pending',
  pgAdminDefaultPassword: 'generated-pending',
  proxyApiKey: 'generated-pending',
}

async function modules() {
  const [config, store] = await Promise.all([
    import('./deployment-config.mjs'),
    import('./deployment-config-store.mjs'),
  ])
  return { ...config, ...store }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

class FakeAws {
  constructor() {
    this.calls = []
    this.parameters = new Map()
    this.afterPointerPut = undefined
  }

  executeAws = ({ args, input }) => {
    this.calls.push({ args: [...args], input })
    const [service, operation] = args
    if (service === 'sts' && operation === 'get-caller-identity') {
      return JSON.stringify({ Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:role/test` })
    }
    if (service === 'ssm' && operation === 'get-parameter') {
      const name = option(args, '--name')
      if (!this.parameters.has(name)) {
        const error = new Error(`ParameterNotFound: ${name}`)
        error.code = 'ParameterNotFound'
        throw error
      }
      return JSON.stringify({ Parameter: { Name: name, Type: 'String', Value: this.parameters.get(name) } })
    }
    if (service === 'ssm' && operation === 'put-parameter') {
      const name = option(args, '--name')
      assert.equal(option(args, '--value'), 'file:///dev/stdin', 'parameter values must travel through stdin')
      if (this.parameters.has(name) && !args.includes('--overwrite')) {
        const error = new Error(`ParameterAlreadyExists: ${name}`)
        error.code = 'ParameterAlreadyExists'
        throw error
      }
      this.parameters.set(name, input)
      if (name === CURRENT_PARAMETER) this.afterPointerPut?.(this)
      return JSON.stringify({ Version: 1, Tier: 'Standard' })
    }
    if (service === 'ssm' && operation === 'delete-parameter') {
      const name = option(args, '--name')
      if (!this.parameters.has(name)) {
        const error = new Error(`ParameterNotFound: ${name}`)
        error.code = 'ParameterNotFound'
        throw error
      }
      this.parameters.delete(name)
      return '{}'
    }
    assert.fail(`unexpected AWS call: ${args.join(' ')}`)
  }
}

async function storeFixture() {
  const { DeploymentConfigStore } = await modules()
  const aws = new FakeAws()
  const store = new DeploymentConfigStore({
    awsCliPath: '/synthetic/aws',
    region: REGION,
    executeAws: aws.executeAws,
  })
  return { aws, store }
}

function publicationInput() {
  return {
    stage: STAGE,
    environment: { ...environment },
    configuredKeys: Object.keys(environment),
    runtimeSecretGenerations,
  }
}

test('publishes immutable bytes before updating and verifying the current pointer', async () => {
  const { aws, store } = await storeFixture()

  const published = store.publish(publicationInput())
  assert.match(published.releaseId, /^[0-9a-f]{64}$/)
  assert.equal(published.isCurrent, true)

  const releaseParameter = `/boxlite/dev/deploy-config/releases/${published.releaseId}`
  const releasePut = aws.calls.findIndex(
    ({ args }) => args[0] === 'ssm' && args[1] === 'put-parameter' && option(args, '--name') === releaseParameter,
  )
  const releaseReadback = aws.calls.findIndex(
    ({ args }, index) =>
      index > releasePut && args[0] === 'ssm' && args[1] === 'get-parameter' && option(args, '--name') === releaseParameter,
  )
  const pointerPut = aws.calls.findIndex(
    ({ args }) => args[0] === 'ssm' && args[1] === 'put-parameter' && option(args, '--name') === CURRENT_PARAMETER,
  )
  const pointerReadback = aws.calls.findIndex(
    ({ args }, index) =>
      index > pointerPut && args[0] === 'ssm' && args[1] === 'get-parameter' && option(args, '--name') === CURRENT_PARAMETER,
  )

  assert.ok(releasePut !== -1 && releasePut < releaseReadback)
  assert.ok(releaseReadback < pointerPut && pointerPut < pointerReadback)
  assert.equal(aws.calls[releasePut].args.includes('--overwrite'), false, 'an immutable release must never overwrite')
  assert.equal(aws.calls[releasePut].args.includes('--tier'), true)
  assert.equal(option(aws.calls[releasePut].args, '--tier'), 'Standard')
  assert.equal(aws.calls[pointerPut].args.includes('--overwrite'), true)
  assert.equal(aws.calls[pointerPut].input, published.releaseId)
  assert.equal(aws.calls[releasePut].args.includes(aws.calls[releasePut].input), false, 'the body must not enter argv')
})

test('prepares and verifies immutable release bytes without moving current until explicit activation', async () => {
  const { aws, store } = await storeFixture()

  const prepared = store.prepare(publicationInput())
  assert.match(prepared.releaseId, /^[0-9a-f]{64}$/)
  assert.equal(aws.parameters.has(CURRENT_PARAMETER), false, 'prepare must not expose the release through current')
  assert.equal(
    aws.parameters.has(`/boxlite/dev/deploy-config/releases/${prepared.releaseId}`),
    true,
    'prepare must retain the verified immutable release for a retry',
  )

  const activated = store.activate({ stage: STAGE, releaseId: prepared.releaseId })
  assert.equal(activated.releaseId, prepared.releaseId)
  assert.equal(activated.isCurrent, true)
  assert.equal(aws.parameters.get(CURRENT_PARAMETER), prepared.releaseId)
})

test('prepares a rebased document as a new release without rewriting its source release', async () => {
  const { aws, store } = await storeFixture()
  const source = store.publish(publicationInput())
  const sourceParameter = `/boxlite/dev/deploy-config/releases/${source.releaseId}`
  const sourceBytes = aws.parameters.get(sourceParameter)
  const rebasedDocument = {
    ...source.document,
    values: {
      ...source.document.values,
      BOXLITE_RUNTIME_SECRET_GENERATIONS: Object.fromEntries(
        Object.keys(runtimeSecretGenerations).map((id) => [id, 'a'.repeat(64)]),
      ),
    },
  }

  const prepared = store.prepareDocument({ document: rebasedDocument })

  assert.notEqual(prepared.releaseId, source.releaseId)
  assert.equal(aws.parameters.get(sourceParameter), sourceBytes, 'rebase must not mutate the historical source release')
  assert.equal(aws.parameters.get(CURRENT_PARAMETER), source.releaseId, 'prepare must not activate the rebased release')
  assert.deepEqual(prepared.document.values.BOXLITE_RUNTIME_SECRET_GENERATIONS, {
    adminApiKey: 'a'.repeat(64),
    clickHouseReaderPassword: 'a'.repeat(64),
    clickHouseWriterPassword: 'a'.repeat(64),
    defaultRunnerApiKey: 'a'.repeat(64),
    encryptionKey: 'a'.repeat(64),
    encryptionSalt: 'a'.repeat(64),
    ghcrPullToken: 'a'.repeat(64),
    otelCollectorApiKey: 'a'.repeat(64),
    otelExporterOtlpHeaders: 'a'.repeat(64),
    pgAdminDefaultPassword: 'a'.repeat(64),
    proxyApiKey: 'a'.repeat(64),
  })
})

test('treats an existing same-digest release as idempotent only after byte verification', async () => {
  const { aws, store } = await storeFixture()
  const first = store.publish(publicationInput())
  aws.calls.length = 0

  const second = store.publish(publicationInput())
  assert.equal(second.releaseId, first.releaseId)
  const releaseName = `/boxlite/dev/deploy-config/releases/${first.releaseId}`
  assert.ok(
    aws.calls.some(
      ({ args }) => args[0] === 'ssm' && args[1] === 'get-parameter' && option(args, '--name') === releaseName,
    ),
    'ParameterAlreadyExists must be followed by exact readback',
  )

  aws.parameters.set(releaseName, '{"tampered":true}')
  aws.calls.length = 0
  assert.throws(() => store.publish(publicationInput()), /existing|immutable|byte|digest/i)
  assert.equal(
    aws.calls.some(({ args }) => args[1] === 'put-parameter' && option(args, '--name') === CURRENT_PARAMETER),
    false,
    'failed immutable release verification must stop before the pointer update',
  )
})

test('resolves current exactly once, while an explicit release never reads the pointer', async () => {
  const { aws, store } = await storeFixture()
  const published = store.publish(publicationInput())

  aws.calls.length = 0
  const current = store.resolve({ stage: STAGE })
  assert.equal(current.releaseId, published.releaseId)
  assert.equal(
    aws.calls.filter(
      ({ args }) => args[0] === 'ssm' && args[1] === 'get-parameter' && option(args, '--name') === CURRENT_PARAMETER,
    ).length,
    1,
  )

  aws.calls.length = 0
  const explicit = store.resolve({ stage: STAGE, releaseId: published.releaseId })
  assert.equal(explicit.releaseId, published.releaseId)
  assert.equal(
    aws.calls.some(({ args }) => option(args, '--name') === CURRENT_PARAMETER),
    false,
    'a pinned workflow run must never consult current again',
  )
  assert.throws(() => store.resolve({ stage: STAGE, releaseId: published.releaseId.toUpperCase() }), /release|sha|digest/i)

  aws.parameters.set(CURRENT_PARAMETER, '../not-a-release')
  aws.calls.length = 0
  assert.throws(() => store.resolve({ stage: STAGE }), /release|sha|digest/i)
  assert.equal(
    aws.calls.some(({ args }) => option(args, '--name')?.includes('/releases/')),
    false,
    'an invalid pointer must be rejected before it can become an SSM path',
  )
})

test('validates account, region, stage, and digest before activation', async () => {
  const { canonicalizeDeploymentConfig, deploymentConfigReleaseId, DeploymentConfigStore } = await modules()
  const aws = new FakeAws()
  const store = new DeploymentConfigStore({
    awsCliPath: '/synthetic/aws',
    region: REGION,
    executeAws: aws.executeAws,
  })
  const wrongRegionDocument = {
    accountId: ACCOUNT_ID,
    region: 'us-east-1',
    schemaVersion: 1,
    stage: STAGE,
    values: { ...environment, BOXLITE_RUNTIME_SECRET_GENERATIONS: runtimeSecretGenerations },
  }
  const source = canonicalizeDeploymentConfig(wrongRegionDocument)
  const releaseId = deploymentConfigReleaseId(source)
  aws.parameters.set(`/boxlite/dev/deploy-config/releases/${releaseId}`, source)

  assert.throws(() => store.activate({ stage: STAGE, releaseId }), /region/i)
  assert.equal(
    aws.calls.some(({ args }) => args[1] === 'put-parameter' && option(args, '--name') === CURRENT_PARAMETER),
    false,
    'an invalid release must not move the pointer',
  )
})

test('activates an existing validated release and verifies the updated pointer', async () => {
  const { aws, store } = await storeFixture()
  const first = store.publish(publicationInput())
  const second = store.publish({
    stage: STAGE,
    environment: { ...environment, OIDC_AUDIENCE: 'boxlite-api-v2' },
    configuredKeys: Object.keys(environment),
    runtimeSecretGenerations,
  })
  assert.notEqual(first.releaseId, second.releaseId)
  aws.calls.length = 0

  const activated = store.activate({ stage: STAGE, releaseId: first.releaseId })
  assert.equal(activated.releaseId, first.releaseId)
  assert.equal(activated.isCurrent, true)
  assert.equal(aws.parameters.get(CURRENT_PARAMETER), first.releaseId)

  const releaseParameter = `/boxlite/dev/deploy-config/releases/${first.releaseId}`
  const releaseRead = aws.calls.findIndex(
    ({ args }) => args[1] === 'get-parameter' && option(args, '--name') === releaseParameter,
  )
  const pointerPut = aws.calls.findIndex(
    ({ args }) => args[1] === 'put-parameter' && option(args, '--name') === CURRENT_PARAMETER,
  )
  const pointerReadback = aws.calls.findIndex(
    ({ args }, index) =>
      index > pointerPut && args[1] === 'get-parameter' && option(args, '--name') === CURRENT_PARAMETER,
  )
  assert.ok(releaseRead !== -1 && releaseRead < pointerPut)
  assert.ok(pointerPut < pointerReadback)
  assert.equal(aws.calls[pointerPut].args.includes('--overwrite'), true)
})

test('reports a concurrent last writer without corrupting either immutable release', async () => {
  const { aws, store } = await storeFixture()
  const competingRelease = 'b'.repeat(64)
  aws.afterPointerPut = (fake) => fake.parameters.set(CURRENT_PARAMETER, competingRelease)

  const published = store.publish(publicationInput())
  assert.equal(published.isCurrent, false)
  assert.equal(aws.parameters.get(CURRENT_PARAMETER), competingRelease)
  assert.equal(
    aws.parameters.has(`/boxlite/dev/deploy-config/releases/${published.releaseId}`),
    true,
    'losing the pointer race must not remove the immutable publication',
  )
})

test('serializes same-stage operations and holds the lock through pointer publication', async () => {
  const { aws, store: firstStore } = await storeFixture()
  const { DeploymentConfigStore } = await modules()
  const secondStore = new DeploymentConfigStore({
    awsCliPath: '/synthetic/aws',
    region: REGION,
    executeAws: aws.executeAws,
  })
  let enterFirst
  const firstEntered = new Promise((resolve) => {
    enterFirst = resolve
  })
  let allowFirstToPublish
  const firstMayPublish = new Promise((resolve) => {
    allowFirstToPublish = resolve
  })
  aws.afterPointerPut = (fake) => {
    assert.equal(
      fake.parameters.get(OPERATION_LOCK_PARAMETER),
      FIRST_LOCK_OWNER,
      'the operation lock must remain owned until the config pointer is published',
    )
  }

  const firstPublication = firstStore.withDeploymentOperationLock(
    { stage: STAGE, ownerId: FIRST_LOCK_OWNER },
    async () => {
      assert.equal(aws.parameters.get(OPERATION_LOCK_PARAMETER), FIRST_LOCK_OWNER)
      enterFirst()
      await firstMayPublish
      return firstStore.publish(publicationInput())
    },
  )
  await firstEntered

  await assert.rejects(
    secondStore.withDeploymentOperationLock({ stage: STAGE, ownerId: SECOND_LOCK_OWNER }, async () => undefined),
    /deployment operation.*already in progress|lock.*exists/i,
  )
  assert.equal(aws.parameters.get(OPERATION_LOCK_PARAMETER), FIRST_LOCK_OWNER)

  allowFirstToPublish()
  const published = await firstPublication
  assert.equal(published.isCurrent, true)
  assert.equal(aws.parameters.has(OPERATION_LOCK_PARAMETER), false)

  await secondStore.withDeploymentOperationLock({ stage: STAGE, ownerId: SECOND_LOCK_OWNER }, async () => {
    assert.equal(aws.parameters.get(OPERATION_LOCK_PARAMETER), SECOND_LOCK_OWNER)
  })
  assert.equal(aws.parameters.has(OPERATION_LOCK_PARAMETER), false)

  const lockPut = aws.calls.find(
    ({ args }) => args[1] === 'put-parameter' && option(args, '--name') === OPERATION_LOCK_PARAMETER,
  )
  assert.ok(lockPut)
  assert.equal(lockPut.args.includes('--overwrite'), false, 'operation lock acquisition must be no-overwrite')
  assert.equal(option(lockPut.args, '--value'), 'file:///dev/stdin')
  assert.equal(lockPut.args.includes(FIRST_LOCK_OWNER), false, 'lock ownership must travel through stdin')
})

test('releases the operation lock in finally but never deletes another owner lock', async () => {
  const { aws, store } = await storeFixture()
  const operationFailure = new Error('synthetic bootstrap operation failed')

  await assert.rejects(
    store.withDeploymentOperationLock({ stage: STAGE, ownerId: FIRST_LOCK_OWNER }, async () => {
      throw operationFailure
    }),
    operationFailure,
  )
  assert.equal(aws.parameters.has(OPERATION_LOCK_PARAMETER), false, 'failure must release the owned lock')

  const deletesBeforeOwnerMismatch = aws.calls.filter(
    ({ args }) => args[1] === 'delete-parameter' && option(args, '--name') === OPERATION_LOCK_PARAMETER,
  ).length
  await assert.rejects(
    store.withDeploymentOperationLock({ stage: STAGE, ownerId: FIRST_LOCK_OWNER }, async () => {
      aws.parameters.set(OPERATION_LOCK_PARAMETER, SECOND_LOCK_OWNER)
    }),
    /owner|ownership|changed/i,
  )
  assert.equal(
    aws.parameters.get(OPERATION_LOCK_PARAMETER),
    SECOND_LOCK_OWNER,
    'owner mismatch must leave the replacement lock intact',
  )
  assert.equal(
    aws.calls.filter(
      ({ args }) => args[1] === 'delete-parameter' && option(args, '--name') === OPERATION_LOCK_PARAMETER,
    ).length,
    deletesBeforeOwnerMismatch,
    'an owner mismatch must not issue a delete for the replacement lock',
  )
})

test('validates a nested operation owner without acquiring or releasing the parent lock', async () => {
  const { aws, store } = await storeFixture()
  const lock = store.acquireDeploymentOperationLock({ stage: STAGE, ownerId: FIRST_LOCK_OWNER })
  const putsBeforeReuse = aws.calls.filter(({ args }) => args[1] === 'put-parameter').length
  const deletesBeforeReuse = aws.calls.filter(({ args }) => args[1] === 'delete-parameter').length

  assert.deepEqual(
    store.assertDeploymentOperationLockOwner({ stage: STAGE, ownerId: FIRST_LOCK_OWNER }),
    lock,
  )
  assert.throws(
    () => store.assertDeploymentOperationLockOwner({ stage: STAGE, ownerId: SECOND_LOCK_OWNER }),
    /different owner/,
  )
  assert.equal(aws.calls.filter(({ args }) => args[1] === 'put-parameter').length, putsBeforeReuse)
  assert.equal(aws.calls.filter(({ args }) => args[1] === 'delete-parameter').length, deletesBeforeReuse)
  assert.equal(aws.parameters.get(OPERATION_LOCK_PARAMETER), FIRST_LOCK_OWNER)

  store.releaseDeploymentOperationLock(lock)
})
