import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalDexDatabase } from './local-dex-env.mjs'

const isolatedEnvironment = {
  BOXLITE_E2E_ISOLATED_DATABASE: '1',
  BOXLITE_E2E_DB_HOST: '127.0.0.1',
  BOXLITE_E2E_DB_PORT: '5432',
  BOXLITE_E2E_DB_USERNAME: 'postgres',
  BOXLITE_E2E_DB_PASSWORD: 'postgres',
  BOXLITE_E2E_DB_DATABASE: 'boxlite_bg_012345abcdef',
}

test('redacts the configured login password from the ready banner', async () => {
  const { formatLoginSummary } = await import('./local-dex-env.mjs')
  const secret = 'sentinel-password-that-must-not-be-logged'
  const summary = formatLoginSummary({
    loginEmail: 'admin@boxlite.dev',
    loginPassword: secret,
  })

  assert.equal(summary, 'admin@boxlite.dev / [configured]')
  assert.ok(!summary.includes(secret))
})

test('passes local service credentials to the E2E command for evidence redaction', async () => {
  const localDexEnvironment = await import('./local-dex-env.mjs')
  assert.equal(typeof localDexEnvironment.buildE2eCommandEnvironment, 'function')

  const environment = localDexEnvironment.buildE2eCommandEnvironment(
    {
      dashboardUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:3001/api',
      dexIssuer: 'http://localhost:5556',
      loginEmail: 'admin@boxlite.dev',
      loginPassword: 'password',
      registryHost: 'localhost:5001',
      runtimeImageTag: 'runtime-test',
    },
    {},
    {},
  )

  assert.equal(environment.ADMIN_API_KEY, 'boxlite-local-admin-key')
  assert.equal(environment.BOXLITE_RUNNER_TOKEN, 'boxlite-local-runner-key')
  assert.equal(environment.PROXY_API_KEY, 'boxlite-local-proxy-key')
  assert.equal(environment.INTERNAL_REGISTRY_PASSWORD, 'boxlite-local-registry-password')
})

test('uses one inherited published image for the API allowlist and E2E command', async () => {
  const { buildE2eCommandEnvironment } = await import('./local-dex-env.mjs')
  const publishedImage = 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
  const environment = buildE2eCommandEnvironment(
    {
      dashboardUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:3001/api',
      dexIssuer: 'http://localhost:5556',
      loginEmail: 'admin@boxlite.dev',
      loginPassword: 'password',
      registryHost: 'localhost:5001',
      runtimeImageTag: 'runtime-test',
    },
    {},
    {
      BOXLITE_E2E_IMAGE: publishedImage,
      BOXLITE_SYSTEM_BASE_IMAGE: 'localhost:5001/boxlite/base:stale-override',
    },
  )

  assert.equal(environment.BOXLITE_E2E_IMAGE, publishedImage)
  assert.equal(environment.BOXLITE_SYSTEM_BASE_IMAGE, publishedImage)
})

test('defaults the API allowlist and E2E command to one local base image', async () => {
  const { buildE2eCommandEnvironment } = await import('./local-dex-env.mjs')
  const environment = buildE2eCommandEnvironment(
    {
      dashboardUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:3001/api',
      dexIssuer: 'http://localhost:5556',
      loginEmail: 'admin@boxlite.dev',
      loginPassword: 'password',
      registryHost: 'localhost:5001',
      runtimeImageTag: 'runtime-test',
    },
    {},
    {},
  )

  assert.equal(environment.BOXLITE_E2E_IMAGE, 'localhost:5001/boxlite/base:runtime-test')
  assert.equal(environment.BOXLITE_SYSTEM_BASE_IMAGE, environment.BOXLITE_E2E_IMAGE)
})

test('maps one validated isolated database to every application and E2E database variable', () => {
  const database = createLocalDexDatabase(isolatedEnvironment, () => {})

  assert.deepEqual(database.environment(), {
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_USERNAME: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_DATABASE: 'boxlite_bg_012345abcdef',
    BOXLITE_E2E_DB_HOST: '127.0.0.1',
    BOXLITE_E2E_DB_PORT: '5432',
    BOXLITE_E2E_DB_USERNAME: 'postgres',
    BOXLITE_E2E_DB_PASSWORD: 'postgres',
    BOXLITE_E2E_DB_DATABASE: 'boxlite_bg_012345abcdef',
    BILLING_E2E_DB_HOST: '127.0.0.1',
    BILLING_E2E_DB_PORT: '5432',
    BILLING_E2E_DB_USERNAME: 'postgres',
    BILLING_E2E_DB_PASSWORD: 'postgres',
    BILLING_E2E_DB_DATABASE: 'boxlite_bg_012345abcdef',
  })
})

test('defaults isolated database connectivity to the local PostgreSQL container', () => {
  const database = createLocalDexDatabase(
    {
      BOXLITE_E2E_ISOLATED_DATABASE: '1',
      BOXLITE_E2E_DB_DATABASE: 'boxlite_bg_abcdef012345',
    },
    () => {},
  )
  const environment = database.environment()

  for (const prefix of ['DB', 'BOXLITE_E2E_DB', 'BILLING_E2E_DB']) {
    assert.equal(environment[`${prefix}_HOST`], 'localhost')
    assert.equal(environment[`${prefix}_PORT`], '5432')
    assert.equal(environment[`${prefix}_USERNAME`], 'postgres')
    assert.equal(environment[`${prefix}_PASSWORD`], 'postgres')
    assert.equal(environment[`${prefix}_DATABASE`], 'boxlite_bg_abcdef012345')
  }
})

test('creates and drops only its validated database, once', () => {
  const calls = []
  const database = createLocalDexDatabase(isolatedEnvironment, (args) => calls.push(args))

  database.create()
  database.create()
  database.drop()
  database.drop()

  assert.deepEqual(calls, [
    [
      'exec',
      'boxlite-local-postgres',
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'CREATE DATABASE "boxlite_bg_012345abcdef"',
    ],
    [
      'exec',
      'boxlite-local-postgres',
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'DROP DATABASE IF EXISTS "boxlite_bg_012345abcdef" WITH (FORCE)',
    ],
  ])
})

test('does not manage a database during an ordinary local E2E run', () => {
  const calls = []
  const database = createLocalDexDatabase(
    {
      BOXLITE_E2E_ISOLATED_DATABASE: '0',
      BOXLITE_E2E_DB_DATABASE: 'boxlite',
    },
    (args) => calls.push(args),
  )

  assert.deepEqual(database.environment(), {})
  database.create()
  database.drop()
  assert.deepEqual(calls, [])
})

test('rejects database targets outside the run-scoped local PostgreSQL contract', () => {
  const invalidOverrides = [
    { BOXLITE_E2E_DB_DATABASE: 'boxlite' },
    { BOXLITE_E2E_DB_DATABASE: 'boxlite_bg_012345ABCDEf' },
    { BOXLITE_E2E_DB_HOST: 'database.example.com' },
    { BOXLITE_E2E_DB_PORT: '25432' },
    { BOXLITE_E2E_DB_USERNAME: 'boxlite' },
    { BOXLITE_E2E_DB_PASSWORD: 'boxlite' },
  ]

  for (const override of invalidOverrides) {
    const calls = []
    assert.throws(
      () => createLocalDexDatabase({ ...isolatedEnvironment, ...override }, (args) => calls.push(args)),
      /isolated database/i,
    )
    assert.deepEqual(calls, [])
  }
})

test('does not claim or drop a database when creation fails', () => {
  const calls = []
  const database = createLocalDexDatabase(isolatedEnvironment, (args) => {
    calls.push(args)
    throw new Error('create failed')
  })

  assert.throws(() => database.create(), /create failed/)
  database.drop()
  assert.equal(calls.length, 1)
})
