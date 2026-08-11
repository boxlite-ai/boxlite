// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RUNTIME_SECRET_DEFINITIONS, runtimeSecretName } from './runtime-secrets.mjs'

const REGION = 'ap-southeast-1'
const STAGE = 'dev'
const EXISTING_VERSION_ID = '11111111-1111-4111-8111-111111111111'
const ROTATED_VERSION_ID = '22222222-2222-4222-8222-222222222222'
const CREATED_VERSION_ID = '33333333-3333-4333-8333-333333333333'

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function ownershipTags(args) {
  return Object.fromEntries(JSON.parse(option(args, '--tags')).map(({ Key, Value }) => [Key, Value]))
}

class FakeSecretsManager {
  constructor() {
    this.calls = []
    this.secrets = new Map(
      RUNTIME_SECRET_DEFINITIONS.map(({ id }) => [
        runtimeSecretName(STAGE, id),
        { initialValue: 'generated', initialization: 'pending', hasCurrentValue: false },
      ]),
    )
  }

  execute = (command, args, options = {}) => {
    assert.equal(command, '/fake/aws')
    const operation = args[1]
    const name = option(args, '--secret-id') ?? option(args, '--name')
    this.calls.push({ operation, name, args: [...args], input: options.input })

    if (operation === 'describe-secret') {
      const secret = this.secrets.get(name)
      if (!secret) {
        const error = new Error(`ResourceNotFoundException: ${name}`)
        error.stderr = 'ResourceNotFoundException'
        throw error
      }
      return JSON.stringify({
        Tags: [
          ...(secret.initialValue
            ? [{ Key: 'boxlite:initial-value', Value: secret.initialValue }]
            : []),
          ...(secret.initialization
            ? [{ Key: 'boxlite:initialization', Value: secret.initialization }]
            : []),
        ],
        ...(secret.omitVersionStages
          ? {}
          : {
              VersionIdsToStages:
                secret.versionStages ??
                (secret.hasCurrentValue ? { [secret.versionId ?? EXISTING_VERSION_ID]: ['AWSCURRENT'] } : {}),
            }),
      })
    }
    if (operation === 'get-secret-value') {
      return JSON.stringify(this.secrets.get(name)?.value)
    }
    if (operation === 'create-secret') {
      const tags = ownershipTags(args)
      this.secrets.set(name, {
        initialValue: tags['boxlite:initial-value'],
        initialization: tags['boxlite:initialization'],
        hasCurrentValue: false,
      })
      return '{}'
    }
    if (operation === 'tag-resource') {
      const secret = this.secrets.get(name)
      const tags = ownershipTags(args)
      secret.initialValue = tags['boxlite:initial-value']
      secret.initialization = tags['boxlite:initialization']
      return '{}'
    }
    if (operation === 'put-secret-value') {
      const secret = this.secrets.get(name)
      secret.value = options.input
      secret.hasCurrentValue = true
      secret.versionId = option(args, '--client-request-token')
      return '{}'
    }
    assert.fail(`unexpected secrets manager operation ${operation}`)
  }

  mutations() {
    return this.calls.filter(({ operation }) =>
      ['create-secret', 'tag-resource', 'put-secret-value'].includes(operation),
    )
  }
}

test('refuses a generated pending container that already has an unexpected staged version', async () => {
  const { planRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const name = runtimeSecretName(STAGE, RUNTIME_SECRET_DEFINITIONS[0].id)
  aws.secrets.set(name, {
    initialValue: 'generated',
    initialization: 'pending',
    hasCurrentValue: false,
    versionStages: { [ROTATED_VERSION_ID]: ['AWSPENDING'] },
  })

  assert.throws(
    () =>
      planRuntimeSecrets({
        awsCliPath: '/fake/aws',
        region: REGION,
        stage: STAGE,
        seeds: [],
        force: false,
        execute: aws.execute,
      }),
    /could not inspect runtime secret container/i,
  )
  assert.deepEqual(aws.mutations(), [], 'unexpected staged metadata must fail during read-only planning')
})

test('accepts the AWS DescribeSecret shape that omits versions for an empty generated container', async () => {
  const { planRuntimeSecrets, runtimeSecretGenerationsFromPlan } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const definition = RUNTIME_SECRET_DEFINITIONS[0]
  const name = runtimeSecretName(STAGE, definition.id)
  aws.secrets.set(name, {
    initialValue: 'generated',
    initialization: 'pending',
    hasCurrentValue: false,
    omitVersionStages: true,
  })

  const plan = planRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [],
    force: false,
    execute: aws.execute,
  })
  assert.equal(runtimeSecretGenerationsFromPlan(plan)[definition.id], 'generated-pending')
  assert.deepEqual(aws.mutations(), [])
})

test('refuses malformed staged metadata beside an otherwise valid AWSCURRENT version', async () => {
  const { planRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const definition = RUNTIME_SECRET_DEFINITIONS[0]
  const name = runtimeSecretName(STAGE, definition.id)
  for (const malformedStages of [null, ['x'.repeat(257)]]) {
    aws.secrets.set(name, {
      initialValue: 'explicit',
      initialization: 'sealed',
      hasCurrentValue: true,
      versionStages: {
        [EXISTING_VERSION_ID]: ['AWSCURRENT'],
        [ROTATED_VERSION_ID]: malformedStages,
      },
    })

    assert.throws(
      () =>
        planRuntimeSecrets({
          awsCliPath: '/fake/aws',
          region: REGION,
          stage: STAGE,
          seeds: [],
          force: false,
          execute: aws.execute,
        }),
      /could not inspect runtime secret container/i,
    )
  }
  assert.deepEqual(aws.mutations(), [])
})

test('pins a complete generation map to observed and preplanned AWSCURRENT version ids', async () => {
  const {
    applyRuntimeSecretPlan,
    planRuntimeSecrets,
    runtimeSecretGenerationsFromPlan,
  } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const adminName = runtimeSecretName(STAGE, 'adminApiKey')
  const proxyName = runtimeSecretName(STAGE, 'proxyApiKey')
  const ghcrName = runtimeSecretName(STAGE, 'ghcrPullToken')
  aws.secrets.set(adminName, {
    initialValue: 'explicit',
    initialization: 'sealed',
    hasCurrentValue: true,
    versionId: EXISTING_VERSION_ID,
    value: 'same-value',
  })
  aws.secrets.set(proxyName, {
    initialValue: 'explicit',
    initialization: 'sealed',
    hasCurrentValue: true,
    versionId: EXISTING_VERSION_ID,
    value: 'old-value',
  })
  aws.secrets.delete(ghcrName)
  const versionIds = [ROTATED_VERSION_ID, CREATED_VERSION_ID]

  const plan = planRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [
      { id: 'adminApiKey', sourceKey: 'ADMIN_API_KEY', value: 'same-value' },
      { id: 'proxyApiKey', sourceKey: 'PROXY_API_KEY', value: 'new-value' },
      { id: 'ghcrPullToken', sourceKey: 'GHCR_TOKEN', value: 'new-ghcr-value' },
    ],
    force: true,
    execute: aws.execute,
    createVersionId: () => versionIds.shift(),
  })
  const generations = runtimeSecretGenerationsFromPlan(plan)

  assert.deepEqual(Object.keys(generations), RUNTIME_SECRET_DEFINITIONS.map(({ id }) => id).sort())
  assert.equal(generations.adminApiKey, EXISTING_VERSION_ID)
  assert.equal(generations.proxyApiKey, ROTATED_VERSION_ID)
  assert.equal(generations.ghcrPullToken, CREATED_VERSION_ID)
  assert.equal(generations.encryptionKey, 'generated-pending')

  applyRuntimeSecretPlan({
    awsCliPath: '/fake/aws',
    region: REGION,
    plan,
    execute: aws.execute,
    log() {},
  })
  const puts = aws.mutations().filter(({ operation }) => operation === 'put-secret-value')
  assert.deepEqual(
    puts.map(({ args }) => option(args, '--client-request-token')),
    [ROTATED_VERSION_ID, CREATED_VERSION_ID],
  )
  assert.equal(puts.some(({ args }) => args.includes('new-value') || args.includes('new-ghcr-value')), false)
})

test('a failed post-rotation bootstrap rerun publishes the observed version without requiring force', async () => {
  const { applyRuntimeSecretPlan, planRuntimeSecrets, runtimeSecretGenerationsFromPlan } =
    await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const proxyName = runtimeSecretName(STAGE, 'proxyApiKey')
  aws.secrets.set(proxyName, {
    initialValue: 'explicit',
    initialization: 'sealed',
    hasCurrentValue: true,
    versionId: EXISTING_VERSION_ID,
    value: 'old-value',
  })

  const rotated = planRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [{ id: 'proxyApiKey', sourceKey: 'PROXY_API_KEY', value: 'new-value' }],
    force: true,
    execute: aws.execute,
    createVersionId: () => ROTATED_VERSION_ID,
  })
  applyRuntimeSecretPlan({ awsCliPath: '/fake/aws', region: REGION, plan: rotated, execute: aws.execute, log() {} })

  aws.calls.length = 0
  const repair = planRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [{ id: 'proxyApiKey', sourceKey: 'PROXY_API_KEY', value: 'new-value' }],
    force: false,
    execute: aws.execute,
    createVersionId: () => assert.fail('same-value repair must reuse AWSCURRENT rather than allocate a rotation'),
  })
  const repairGenerations = runtimeSecretGenerationsFromPlan(repair)

  assert.equal(repair.find(({ id }) => id === 'proxyApiKey').action, 'retain-explicit')
  assert.equal(repairGenerations.proxyApiKey, ROTATED_VERSION_ID)
  assert.deepEqual(aws.mutations(), [])
})

test('prepares release, applies the secret plan, and activates only after a complete apply', async () => {
  const { commitBootstrapConfigRelease } = await import('./bootstrap-environment.mjs')
  const events = []
  const store = {
    prepare(input) {
      events.push(['prepare', input])
      return { releaseId: 'a'.repeat(64) }
    },
    activate(input) {
      events.push(['activate', input])
      return { releaseId: input.releaseId, isCurrent: true }
    },
  }
  const publicationInput = { stage: STAGE, environment: {}, configuredKeys: [], runtimeSecretGenerations: {} }
  const applyFailure = new Error('synthetic partial secret apply')

  assert.throws(
    () =>
      commitBootstrapConfigRelease({
        deploymentConfigStore: store,
        publicationInput,
        applyRuntimeSecrets() {
          events.push(['apply'])
          throw applyFailure
        },
      }),
    applyFailure,
  )
  assert.deepEqual(events.map(([operation]) => operation), ['prepare', 'apply'])

  events.length = 0
  const wiringFailure = new Error('synthetic GitHub wiring failure')
  assert.throws(
    () =>
      commitBootstrapConfigRelease({
        deploymentConfigStore: store,
        publicationInput,
        deployBootstrapPolicy() {
          events.push(['policy-and-wiring'])
          throw wiringFailure
        },
        applyRuntimeSecrets() {
          events.push(['apply'])
        },
      }),
    wiringFailure,
  )
  assert.deepEqual(
    events.map(([operation]) => operation),
    ['prepare', 'policy-and-wiring'],
    'a failed prerequisite must leave runtime generations and current untouched',
  )

  events.length = 0
  const publication = commitBootstrapConfigRelease({
    deploymentConfigStore: store,
    publicationInput,
    applyRuntimeSecrets() {
      events.push(['apply'])
    },
  })
  assert.equal(publication.isCurrent, true)
  assert.deepEqual(events.map(([operation]) => operation), ['prepare', 'apply', 'activate'])
})

test('orders runtime initialization policy and sealing safely around the immutable release', async () => {
  const { commitBootstrapConfigRelease } = await import('./bootstrap-environment.mjs')
  const publicationInput = { stage: STAGE, environment: {}, configuredKeys: [], runtimeSecretGenerations: {} }
  const store = {
    prepare() {
      events.push('prepare')
      return { releaseId: 'a'.repeat(64) }
    },
    activate() {
      events.push('activate')
      return { releaseId: 'a'.repeat(64), isCurrent: true }
    },
  }
  const events = []
  const commit = (runtimeSecretInitializationEnabled) =>
    commitBootstrapConfigRelease({
      deploymentConfigStore: store,
      publicationInput,
      runtimeSecretInitializationEnabled,
      sealRuntimeSecrets() {
        events.push('seal-current')
      },
      deployBootstrapPolicy() {
        events.push(`policy-${runtimeSecretInitializationEnabled ? 'enabled' : 'disabled'}`)
      },
      applyRuntimeSecrets() {
        events.push('apply-remaining')
      },
    })

  commit(true)
  assert.deepEqual(events, ['prepare', 'seal-current', 'policy-enabled', 'apply-remaining', 'activate'])
  events.length = 0
  commit(false)
  assert.deepEqual(events, ['prepare', 'policy-disabled', 'seal-current', 'apply-remaining', 'activate'])
})

test('mixed runtime plan seals current generated secrets before enabling only new pending initialization', async () => {
  const {
    applyRuntimeSecretPlanSubset,
    partitionRuntimeSecretPlanForInitializationGate,
    planRuntimeSecrets,
    runtimeSecretInitializationRequired,
  } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const [oldDefinition, newDefinition] = RUNTIME_SECRET_DEFINITIONS
  const oldName = runtimeSecretName(STAGE, oldDefinition.id)
  const newName = runtimeSecretName(STAGE, newDefinition.id)
  aws.secrets.set(oldName, {
    initialValue: 'generated',
    initialization: 'pending',
    hasCurrentValue: true,
    versionId: EXISTING_VERSION_ID,
  })
  aws.secrets.delete(newName)

  const plan = planRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [],
    force: false,
    execute: aws.execute,
  })
  assert.equal(runtimeSecretInitializationRequired(plan), true)
  const { sealBeforeEnable, remaining } = partitionRuntimeSecretPlanForInitializationGate(plan)
  assert.deepEqual(sealBeforeEnable.map(({ id }) => id), [oldDefinition.id])
  assert.ok(remaining.some(({ id, action }) => id === newDefinition.id && action === 'create-generated'))

  applyRuntimeSecretPlanSubset({
    awsCliPath: '/fake/aws',
    region: REGION,
    plan: sealBeforeEnable,
    execute: aws.execute,
    log() {},
  })
  assert.deepEqual(aws.secrets.get(oldName), {
    initialValue: 'generated',
    initialization: 'sealed',
    hasCurrentValue: true,
    versionId: EXISTING_VERSION_ID,
  })
  assert.equal(aws.secrets.has(newName), false, 'new pending container is created only after policy enablement')
})

test('plans every runtime secret read-only before a late rotation refusal', async () => {
  const { ensureRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const lateDefinition = RUNTIME_SECRET_DEFINITIONS.at(-1)
  const lateName = runtimeSecretName(STAGE, lateDefinition.id)
  aws.secrets.set(lateName, {
    initialValue: 'explicit',
    initialization: 'sealed',
    hasCurrentValue: true,
    value: 'existing-value',
  })

  assert.throws(
    () =>
      ensureRuntimeSecrets({
        awsCliPath: '/fake/aws',
        region: REGION,
        stage: STAGE,
        seeds: [{ id: lateDefinition.id, sourceKey: 'BOXLITE_API_KEY', value: 'different-value' }],
        force: false,
        execute: aws.execute,
        log() {},
      }),
    /differs.*--force/,
  )
  assert.equal(aws.calls.filter(({ operation }) => operation === 'describe-secret').length, 11)
  assert.deepEqual(aws.mutations(), [], 'planning failure must not partially mutate an earlier secret')
})

test('encryption key material is non-rotatable in v1 but permits initial seed and same-value replay', async () => {
  const { ensureRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const definitions = RUNTIME_SECRET_DEFINITIONS.filter(({ id }) => ['encryptionKey', 'encryptionSalt'].includes(id))
  const oldValue = 'OLDKEY42'
  const newValue = 'NEWKEY42'

  for (const definition of definitions) {
    const name = runtimeSecretName(STAGE, definition.id)
    const sourceKey = definition.environmentKeys[0]
    const changed = new FakeSecretsManager()
    changed.secrets.set(name, {
      initialValue: 'explicit',
      initialization: 'sealed',
      hasCurrentValue: true,
      value: oldValue,
    })

    assert.throws(
      () =>
        ensureRuntimeSecrets({
          awsCliPath: '/fake/aws',
          region: REGION,
          stage: STAGE,
          seeds: [{ id: definition.id, sourceKey, value: newValue }],
          force: true,
          execute: changed.execute,
          log() {},
        }),
      (error) => {
        const messages = []
        for (let current = error; current; current = current.cause) messages.push(current.message ?? String(current))
        assert.match(messages[0], /cannot be rotated in v1.*ciphertext|non-rotatable in v1/i)
        assert.doesNotMatch(messages.join('\n'), new RegExp(`${oldValue}|${newValue}`))
        return true
      },
    )
    assert.deepEqual(changed.mutations(), [], 'rotation refusal must occur during the read-only plan')

    const unchanged = new FakeSecretsManager()
    unchanged.secrets.set(name, {
      initialValue: 'explicit',
      initialization: 'sealed',
      hasCurrentValue: true,
      value: oldValue,
    })
    ensureRuntimeSecrets({
      awsCliPath: '/fake/aws',
      region: REGION,
      stage: STAGE,
      seeds: [{ id: definition.id, sourceKey, value: oldValue }],
      force: true,
      execute: unchanged.execute,
      log() {},
    })
    assert.deepEqual(unchanged.mutations(), [], 'same-value bootstrap must remain idempotent')

    const initial = new FakeSecretsManager()
    initial.secrets.delete(name)
    ensureRuntimeSecrets({
      awsCliPath: '/fake/aws',
      region: REGION,
      stage: STAGE,
      seeds: [{ id: definition.id, sourceKey, value: newValue }],
      force: true,
      execute: initial.execute,
      log() {},
    })
    assert.deepEqual(
      initial.mutations().map(({ operation }) => operation),
      ['create-secret', 'put-secret-value'],
    )
    assert.equal(definition.rotationPolicy, 'non-rotatable-v1')
  }
})

test('malformed runtime secret output never survives in the bootstrap error chain', async () => {
  const { ensureRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const aws = new FakeSecretsManager()
  const definition = RUNTIME_SECRET_DEFINITIONS[0]
  const name = runtimeSecretName(STAGE, definition.id)
  const sentinel = 'S3CR3T42'
  aws.secrets.set(name, {
    initialValue: 'explicit',
    initialization: 'sealed',
    hasCurrentValue: true,
    value: 'existing-value',
  })
  const execute = (command, args, options) => {
    if (args[1] === 'get-secret-value') return sentinel
    return aws.execute(command, args, options)
  }

  assert.throws(
    () =>
      ensureRuntimeSecrets({
        awsCliPath: '/fake/aws',
        region: REGION,
        stage: STAGE,
        seeds: [{ id: definition.id, sourceKey: 'ENCRYPTION_KEY', value: 'different-value' }],
        force: false,
        execute,
        log() {},
      }),
    (error) => {
      const messages = []
      for (let current = error; current; current = current.cause) messages.push(current.message ?? String(current))
      assert.match(messages[0], /could not compare the existing value/)
      assert.doesNotMatch(messages.join('\n'), new RegExp(sentinel))
      return true
    },
  )
  assert.deepEqual(aws.mutations(), [])
})

test('runtime secret seed failures discard captured value-bearing executor output', async () => {
  const { applyRuntimeSecretPlan } = await import('./bootstrap-environment.mjs')
  const sentinel = 'S3CR3T42'
  const execute = (_command, args) => {
    if (args[1] === 'tag-resource') return '{}'
    const error = new Error(`synthetic put failure ${sentinel}`)
    error.stderr = sentinel
    throw error
  }

  assert.throws(
    () =>
      applyRuntimeSecretPlan({
        awsCliPath: '/fake/aws',
        region: REGION,
        plan: RUNTIME_SECRET_DEFINITIONS.map(({ id }, index) =>
          index === 0
            ? {
                id,
                name: runtimeSecretName(STAGE, id),
                action: 'seed-explicit',
                seed: { value: 'synthetic-input-value' },
                generation: ROTATED_VERSION_ID,
                message: 'seeded from local input',
              }
            : {
                id,
                name: runtimeSecretName(STAGE, id),
                action: 'retain-generated',
                generation: 'generated-pending',
                message: 'generated value retained',
              },
        ),
        execute,
        log() {},
      }),
    (error) => {
      const messages = []
      for (let current = error; current; current = current.cause) messages.push(current.message ?? String(current))
      assert.match(messages[0], /could not seed runtime secret/)
      assert.doesNotMatch(messages.join('\n'), new RegExp(sentinel))
      return true
    },
  )
})

test('SecureString put failures discard captured value-bearing executor output', async () => {
  const { putSsmSecureParameter } = await import('./bootstrap-environment.mjs')
  const sentinel = 'S3CR3T42'
  const execute = () => {
    const error = new Error(`synthetic parameter failure ${sentinel}`)
    error.stderr = sentinel
    throw error
  }

  assert.throws(
    () =>
      putSsmSecureParameter('/fake/aws', REGION, '/boxlite/dev/cloudflare-api-token', 'synthetic-input-value', {
        execute,
      }),
    (error) => {
      const messages = []
      for (let current = error; current; current = current.cause) messages.push(current.message ?? String(current))
      assert.match(messages[0], /could not update SecureString parameter/)
      assert.doesNotMatch(messages.join('\n'), new RegExp(sentinel))
      return true
    },
  )
})

test('SecureString value reads decrypt in memory, distinguish absence, and hide AWS output', async () => {
  const { readSsmSecureParameter } = await import('./bootstrap-environment.mjs')
  const calls = []
  const execute = (command, args, options) => {
    calls.push({ command, args, options })
    return 'synthetic-existing-value\n'
  }
  assert.deepEqual(
    readSsmSecureParameter('/fake/aws', REGION, '/boxlite/dev/cloudflare-api-token', { execute }),
    { exists: true, value: 'synthetic-existing-value' },
  )
  assert.deepEqual(calls[0].args.slice(0, 2), ['ssm', 'get-parameter'])
  assert.ok(calls[0].args.includes('--with-decryption'))
  assert.equal(calls[0].args.includes('synthetic-existing-value'), false)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])

  const missing = new Error('missing')
  missing.stderr = 'ParameterNotFound'
  assert.deepEqual(
    readSsmSecureParameter('/fake/aws', REGION, '/boxlite/dev/cloudflare-account-id', {
      execute() {
        throw missing
      },
    }),
    { exists: false },
  )

  const sentinel = 'S3CR3T42-access-denied-detail'
  const denied = new Error(sentinel)
  denied.stderr = sentinel
  assert.throws(
    () =>
      readSsmSecureParameter('/fake/aws', REGION, '/boxlite/dev/cloudflare-account-id', {
        execute() {
          throw denied
        },
      }),
    (error) => {
      assert.match(error.message, /could not load SecureString parameter/i)
      assert.doesNotMatch(error.message, new RegExp(sentinel))
      return true
    },
  )
})

test('SecureString creation is non-overwriting while an existing forced rotation opts into overwrite', async () => {
  const { putSsmSecureParameter } = await import('./bootstrap-environment.mjs')
  const calls = []
  const execute = (...args) => calls.push(args)
  const name = '/boxlite/dev/cloudflare-api-token'

  putSsmSecureParameter('/fake/aws', REGION, name, 'new-value', { execute })
  putSsmSecureParameter('/fake/aws', REGION, name, 'rotated-value', { execute, overwrite: true })

  assert.equal(calls[0][1].includes('--overwrite'), false)
  assert.equal(calls[1][1].includes('--overwrite'), true)
  assert.equal(calls[0][1].includes('new-value'), false)
  assert.equal(calls[1][1].includes('rotated-value'), false)
})

test('Cloudflare bootstrap retains existing SecureStrings unless force explicitly rotates them', async () => {
  const { ensureCloudflareCredentials } = await import('./bootstrap-environment.mjs')
  const environment = {
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token-value',
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-cloudflare-account-value',
  }

  for (const { exists, force, expectedPuts, expectedOverwrite } of [
    { exists: true, force: false, expectedPuts: 0, expectedOverwrite: undefined },
    { exists: false, force: false, expectedPuts: 2, expectedOverwrite: false },
    { exists: true, force: true, expectedPuts: 2, expectedOverwrite: true },
  ]) {
    const puts = []
    const prompts = []
    await ensureCloudflareCredentials({
      awsCliPath: '/fake/aws',
      region: REGION,
      stage: STAGE,
      force,
      environment,
      readParameter(_awsCliPath, _region, name) {
        return exists ? { exists: true, value: `existing-value-for-${name}` } : { exists: false }
      },
      putParameter(...args) {
        puts.push(args)
      },
      async prompt(label) {
        prompts.push(label)
        return 'unexpected-prompt-value'
      },
      log() {},
    })

    assert.equal(puts.length, expectedPuts)
    assert.deepEqual(prompts, [])
    for (const args of puts) {
      assert.ok(Object.values(environment).includes(args[3]))
      assert.equal(args.slice(0, 3).some((value) => Object.values(environment).includes(value)), false)
      assert.equal(args[4]?.overwrite, expectedOverwrite)
    }
  }
})

test('Cloudflare bootstrap prepares authoritative credentials before state inspection and applies the same plan later', async () => {
  const {
    applyCloudflareCredentialPlan,
    injectCloudflareCredentialPlan,
    planCloudflareCredentials,
  } = await import('./bootstrap-environment.mjs')
  const localEnvironment = {
    CLOUDFLARE_API_TOKEN: 'stale-local-token',
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'stale-local-account',
  }
  const authoritative = new Map([
    ['/boxlite/dev/cloudflare-api-token', 'authoritative-token'],
    ['/boxlite/dev/cloudflare-account-id', 'authoritative-account'],
  ])
  const prompts = []
  const plan = await planCloudflareCredentials({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    force: false,
    environment: localEnvironment,
    readParameter(_awsCliPath, _region, name) {
      return { exists: true, value: authoritative.get(name) }
    },
    async prompt(label) {
      prompts.push(label)
      return 'unexpected-prompt-value'
    },
  })

  const stateExportEnvironment = {
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: '',
  }
  injectCloudflareCredentialPlan(stateExportEnvironment, plan)
  assert.deepEqual(prompts, [])
  assert.equal(stateExportEnvironment.CLOUDFLARE_API_TOKEN, 'authoritative-token')
  assert.equal(stateExportEnvironment.CLOUDFLARE_DEFAULT_ACCOUNT_ID, 'authoritative-account')

  const puts = []
  applyCloudflareCredentialPlan({
    awsCliPath: '/fake/aws',
    region: REGION,
    plan,
    putParameter(...args) {
      puts.push(args)
    },
    log() {},
  })
  assert.deepEqual(puts, [], 'retained credentials must not be rewritten after state inspection')
})

test('Cloudflare bootstrap uses one prepared value for first-stage state inspection and the later SecureString write', async () => {
  const {
    applyCloudflareCredentialPlan,
    injectCloudflareCredentialPlan,
    planCloudflareCredentials,
  } = await import('./bootstrap-environment.mjs')
  const environment = {
    CLOUDFLARE_API_TOKEN: 'first-stage-token',
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'first-stage-account',
  }
  const plan = await planCloudflareCredentials({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    force: false,
    environment,
    readParameter() {
      return { exists: false }
    },
    async prompt() {
      assert.fail('explicit first-stage credentials must not prompt')
    },
  })
  const stateExportEnvironment = {}
  injectCloudflareCredentialPlan(stateExportEnvironment, plan)

  const puts = []
  applyCloudflareCredentialPlan({
    awsCliPath: '/fake/aws',
    region: REGION,
    plan,
    putParameter(...args) {
      puts.push(args)
    },
    log() {},
  })
  assert.equal(puts.length, 2)
  assert.deepEqual(
    puts.map((args) => ({ name: args[2], value: args[3], overwrite: args[4]?.overwrite })),
    [
      { name: '/boxlite/dev/cloudflare-api-token', value: 'first-stage-token', overwrite: false },
      { name: '/boxlite/dev/cloudflare-account-id', value: 'first-stage-account', overwrite: false },
    ],
  )
  assert.equal(stateExportEnvironment.CLOUDFLARE_API_TOKEN, puts[0][3])
  assert.equal(stateExportEnvironment.CLOUDFLARE_DEFAULT_ACCOUNT_ID, puts[1][3])
})

test('rejects an explicit-tagged secret without AWSCURRENT unless a local seed repairs it', async () => {
  const { ensureRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const definition = RUNTIME_SECRET_DEFINITIONS.at(-1)
  const name = runtimeSecretName(STAGE, definition.id)
  const invalid = new FakeSecretsManager()
  invalid.secrets.set(name, { initialValue: 'explicit', initialization: 'sealed', hasCurrentValue: false })

  assert.throws(
    () =>
      ensureRuntimeSecrets({
        awsCliPath: '/fake/aws',
        region: REGION,
        stage: STAGE,
        seeds: [],
        force: false,
        execute: invalid.execute,
        log() {},
      }),
    /explicit.*AWSCURRENT|explicit.*unset/i,
  )
  assert.deepEqual(invalid.mutations(), [])

  const repaired = new FakeSecretsManager()
  repaired.secrets.set(name, { initialValue: 'explicit', initialization: 'sealed', hasCurrentValue: false })
  ensureRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [{ id: definition.id, sourceKey: 'BOXLITE_API_KEY', value: 'replacement-value' }],
    force: false,
    execute: repaired.execute,
    log() {},
  })
  assert.deepEqual(
    repaired.mutations().map(({ operation }) => operation),
    ['put-secret-value', 'tag-resource'],
  )
  assert.deepEqual(ownershipTags(repaired.mutations().find(({ operation }) => operation === 'tag-resource').args), {
    'boxlite:initial-value': 'explicit',
    'boxlite:initialization': 'sealed',
  })
  const put = repaired.mutations().find(({ operation }) => operation === 'put-secret-value')
  assert.equal(option(put.args, '--secret-string'), 'file:///dev/stdin')
  assert.equal(put.args.includes('replacement-value'), false)
})

test('creates a seeded container as bootstrap-owned explicit and sealed', async () => {
  const { ensureRuntimeSecrets } = await import('./bootstrap-environment.mjs')
  const definition = RUNTIME_SECRET_DEFINITIONS[0]
  const name = runtimeSecretName(STAGE, definition.id)
  const aws = new FakeSecretsManager()
  aws.secrets.delete(name)

  ensureRuntimeSecrets({
    awsCliPath: '/fake/aws',
    region: REGION,
    stage: STAGE,
    seeds: [{ id: definition.id, sourceKey: 'ENCRYPTION_KEY', value: 'replacement-value' }],
    force: false,
    execute: aws.execute,
    log() {},
  })

  assert.deepEqual(
    aws.mutations().map(({ operation }) => operation),
    ['create-secret', 'put-secret-value'],
  )
  assert.deepEqual(ownershipTags(aws.mutations()[0].args), {
    'boxlite:initial-value': 'explicit',
    'boxlite:initialization': 'sealed',
  })
})
