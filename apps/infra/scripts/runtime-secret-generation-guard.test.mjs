// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalizeDeploymentConfig, deploymentConfigReleaseId } from './deployment-config.mjs'
import { RUNTIME_SECRET_DEFINITIONS, runtimeSecretName } from './runtime-secrets.mjs'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-southeast-1'
const STAGE = 'dev'
const EXPECTED_VERSION = 'a'.repeat(64)
const ACTUAL_VERSION = 'b'.repeat(64)
const expectedGenerations = Object.fromEntries(
  RUNTIME_SECRET_DEFINITIONS.map(({ id }) => [id, EXPECTED_VERSION]),
)

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function secretMetadata({
  generation,
  initialValue,
  initialization = generation === undefined ? 'pending' : 'sealed',
}) {
  return JSON.stringify({
    Tags: [
      ...(initialValue === undefined ? [] : [{ Key: 'boxlite:initial-value', Value: initialValue }]),
      ...(initialization === undefined ? [] : [{ Key: 'boxlite:initialization', Value: initialization }]),
    ],
    VersionIdsToStages: generation === undefined ? {} : { [generation]: ['AWSCURRENT'] },
  })
}

test('compares all eleven pinned generations with AWSCURRENT metadata and accepts an exact snapshot', async () => {
  const { assertRuntimeSecretGenerationsCurrent } = await import('./runtime-secret-generation-guard.mjs')
  const calls = []
  const actualGenerations = { ...expectedGenerations, encryptionKey: 'generated-pending' }
  const expected = { ...actualGenerations }

  const result = assertRuntimeSecretGenerationsCurrent({
    stage: STAGE,
    region: REGION,
    awsCliPath: '/synthetic/aws',
    expectedGenerations: expected,
    executeAws({ args }) {
      calls.push(args)
      assert.deepEqual(args.slice(0, 2), ['secretsmanager', 'describe-secret'])
      const name = option(args, '--secret-id')
      const id = RUNTIME_SECRET_DEFINITIONS.find((definition) => runtimeSecretName(STAGE, definition.id) === name)?.id
      assert.ok(id, 'guard must inspect only registered stage secret names')
      const generation = actualGenerations[id]
      return secretMetadata({
        generation: generation === 'generated-pending' ? undefined : generation,
        initialValue: generation === 'generated-pending' ? 'generated' : 'explicit',
      })
    },
  })

  assert.deepEqual(result, expected)
  assert.equal(calls.filter((args) => args[0] === 'secretsmanager').length, RUNTIME_SECRET_DEFINITIONS.length)
  assert.equal(calls.some((args) => args.includes('get-secret-value')), false)
})

test('allows pending only for generated ownership and rejects missing, explicit, updating, or unknown ownership', async () => {
  const { readRuntimeSecretGenerations } = await import('./runtime-secret-generation-guard.mjs')

  const readWithFirstSecret = (metadata) =>
    readRuntimeSecretGenerations({
      stage: STAGE,
      region: REGION,
      awsCliPath: '/synthetic/aws',
      executeAws() {
        return metadata
      },
    })

  const pending = readWithFirstSecret(secretMetadata({ initialValue: 'generated' }))
  assert.deepEqual(
    pending,
    Object.fromEntries(RUNTIME_SECRET_DEFINITIONS.map(({ id }) => [id, 'generated-pending'])),
  )

  for (const initialValue of [undefined, 'explicit', 'updating', 'unknown-owner-sentinel']) {
    assert.throws(
      () => readWithFirstSecret(secretMetadata({ initialValue })),
      (error) => {
        assert.match(error.message, /could not verify runtime secret generations from AWS metadata/i)
        assert.doesNotMatch(error.message, /explicit|updating|unknown-owner-sentinel|boxlite:initial-value/i)
        return true
      },
    )
  }

  assert.throws(
    () =>
      readWithFirstSecret(
        secretMetadata({ generation: EXPECTED_VERSION, initialValue: 'updating' }),
      ),
    /could not verify runtime secret generations from AWS metadata/i,
  )

  assert.throws(
    () =>
      readWithFirstSecret(
        secretMetadata({
          generation: EXPECTED_VERSION,
          initialValue: 'generated',
          initialization: 'pending',
        }),
      ),
    /could not verify runtime secret generations from AWS metadata/i,
  )
})

test('rejects a stale pinned generation without exposing either version or any AWS output', async () => {
  const { assertRuntimeSecretGenerationsCurrent } = await import('./runtime-secret-generation-guard.mjs')
  const awsOutputSentinel = 'metadata-output-sentinel-that-must-not-print'

  assert.throws(
    () =>
      assertRuntimeSecretGenerationsCurrent({
        stage: STAGE,
        region: REGION,
        awsCliPath: '/synthetic/aws',
        expectedGenerations,
        executeAws({ args }) {
          const name = option(args, '--secret-id')
          const isProxy = name === runtimeSecretName(STAGE, 'proxyApiKey')
          return secretMetadata({
            generation: isProxy ? ACTUAL_VERSION : EXPECTED_VERSION,
            initialValue: 'explicit',
          })
        },
      }),
    (error) => {
      assert.match(error.message, /runtime secret generations.*pinned deployment config/i)
      assert.doesNotMatch(error.message, new RegExp(`${EXPECTED_VERSION}|${ACTUAL_VERSION}|${awsOutputSentinel}`))
      return true
    },
  )
})

test('the stack wrapper rejects stale generations before provider lookup or native SST', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-runtime-generation-wrapper-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsCalls = join(fixture, 'aws-calls.jsonl')
  const sstMarker = join(fixture, 'sst-called')
  const operationLock = join(fixture, 'operation-lock')
  const providerSentinel = 'provider-secret-that-must-not-be-read-or-printed'
  const configSource = canonicalizeDeploymentConfig({
    accountId: ACCOUNT_ID,
    region: REGION,
    schemaVersion: 1,
    stage: STAGE,
    values: {
      BOXLITE_RUNTIME_SECRET_GENERATIONS: expectedGenerations,
      OIDC_AUDIENCE: 'boxlite-api',
      OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
      STACK_DOMAIN: 'dev.example.test',
    },
  })
  const configRelease = deploymentConfigReleaseId(configSource)

  writeFileSync(
    fakeAws,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
appendFileSync(process.env.SYNTHETIC_AWS_CALLS, JSON.stringify(args) + '\\n')
if (args[0] === 'sts') {
  process.stdout.write(JSON.stringify({ Account: '${ACCOUNT_ID}' }))
} else if (args[0] === 'ssm' && args[1] === 'put-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  try {
    writeFileSync(process.env.SYNTHETIC_OPERATION_LOCK, readFileSync(0, 'utf8'), { flag: 'wx' })
    process.stdout.write(JSON.stringify({ Version: 1 }))
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    process.stderr.write('ParameterAlreadyExists')
    process.exit(254)
  }
} else if (args[0] === 'ssm' && args[1] === 'delete-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  unlinkSync(process.env.SYNTHETIC_OPERATION_LOCK)
  process.stdout.write('{}')
} else if (args[0] === 'ssm' && args[1] === 'get-parameter') {
  const name = option('--name')
  if (name.includes('/deploy-config/releases/')) {
    process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: process.env.SYNTHETIC_CONFIG_SOURCE } }))
  } else if (name.endsWith('/deployment-operation-lock') && existsSync(process.env.SYNTHETIC_OPERATION_LOCK)) {
    process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: readFileSync(process.env.SYNTHETIC_OPERATION_LOCK, 'utf8') } }))
  } else if (name.includes('cloudflare-')) {
    process.stdout.write(process.env.SYNTHETIC_PROVIDER_SENTINEL)
  } else {
    process.exit(91)
  }
} else if (args[0] === 'secretsmanager' && args[1] === 'describe-secret') {
  process.stdout.write(JSON.stringify({
    Tags: [
      { Key: 'boxlite:initial-value', Value: 'explicit' },
      { Key: 'boxlite:initialization', Value: 'sealed' },
    ],
    VersionIdsToStages: { ['${ACTUAL_VERSION}']: ['AWSCURRENT'] },
  }))
} else {
  process.exit(92)
}
`,
  )
  writeFileSync(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n')
  chmodSync(fakeAws, 0o755)
  chmodSync(fakeSst, 0o755)

  try {
    const wrapperOptions = {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        AWS_CLI_PATH: fakeAws,
        AWS_REGION: REGION,
        BOXLITE_DEPLOY_CONFIG_RELEASE: configRelease,
        SST_BIN_PATH: fakeSst,
        BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
        SYNTHETIC_AWS_CALLS: awsCalls,
        SYNTHETIC_CONFIG_SOURCE: configSource,
        SYNTHETIC_OPERATION_LOCK: operationLock,
        SYNTHETIC_PROVIDER_SENTINEL: providerSentinel,
        SYNTHETIC_SST_MARKER: sstMarker,
      },
    }

    const competingOwner = '11111111-1111-4111-8111-111111111111'
    writeFileSync(operationLock, competingOwner)
    const contended = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'remove', '--stage', STAGE],
      wrapperOptions,
    )
    assert.notEqual(contended.status, 0)
    assert.match(contended.stderr, /deployment operation.*already in progress/i)
    assert.equal(existsSync(sstMarker), false, 'a contended operation lock must stop before native SST')
    assert.equal(readFileSync(operationLock, 'utf8'), competingOwner, 'a contender must not delete the owner lock')
    rmSync(operationLock)

    const result = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'remove', '--stage', STAGE],
      wrapperOptions,
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /runtime secret generations.*pinned deployment config/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${EXPECTED_VERSION}|${ACTUAL_VERSION}|${providerSentinel}`))
    assert.equal(existsSync(sstMarker), false)
    assert.equal(existsSync(operationLock), false, 'generation refusal must release the owned operation lock')
    const calls = readFileSync(awsCalls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(
      calls.some((args) => args.includes('/boxlite/dev/cloudflare-api-token')),
      false,
      'generation mismatch must fail before provider credential lookup',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
