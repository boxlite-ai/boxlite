import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAppsCommand, buildLocalDexConfig } from './local-dex-env.mjs'

test('keeps the original local environment defaults', () => {
  const config = buildLocalDexConfig({})

  assert.equal(config.instance, '')
  assert.equal(config.headless, false)
  assert.equal(config.dashboardUrl, 'http://localhost:3000')
  assert.equal(config.apiUrl, 'http://localhost:3001/api')
  assert.equal(config.postgresContainer, 'boxlite-local-postgres')
  assert.equal(config.postgresVolume, 'boxlite-local-postgres')
  assert.equal(config.postgresPort, 5432)
  assert.equal(config.redisContainer, 'boxlite-local-redis')
  assert.equal(config.redisPort, 6379)
  assert.equal(config.runnerApiPort, 8080)
  assert.equal(config.proxyPort, 4000)
})

test('isolates a headless chaos instance while sharing image infrastructure', () => {
  const config = buildLocalDexConfig({
    BOXLITE_E2E_INSTANCE: 'pr1-chaos',
    BOXLITE_E2E_HEADLESS: 'true',
    BOXLITE_E2E_API_PORT: '3101',
    BOXLITE_E2E_POSTGRES_PORT: '55432',
    BOXLITE_E2E_REDIS_PORT: '16379',
    BOXLITE_E2E_RUNNER_API_PORT: '8081',
    BOXLITE_E2E_PROXY_PORT: '4100',
  })

  assert.equal(config.instance, 'pr1-chaos')
  assert.equal(config.headless, true)
  assert.equal(config.apiUrl, 'http://localhost:3101/api')
  assert.equal(config.postgresContainer, 'boxlite-local-postgres-pr1-chaos')
  assert.equal(config.postgresVolume, 'boxlite-local-postgres-pr1-chaos')
  assert.equal(config.postgresPort, 55432)
  assert.equal(config.redisContainer, 'boxlite-local-redis-pr1-chaos')
  assert.equal(config.redisPort, 16379)
  assert.equal(config.runnerApiPort, 8081)
  assert.equal(config.proxyPort, 4100)
  assert.equal(config.runnerHomeDir, '/tmp/blrt-pr1-chaos')

  assert.equal(config.dexContainer, 'boxlite-local-dex')
  assert.equal(config.registryContainer, 'boxlite-local-registry')
  assert.equal(config.registryHost, 'localhost:5001')
})

test('rejects unsafe instance names and invalid ports', () => {
  assert.throws(() => buildLocalDexConfig({ BOXLITE_E2E_INSTANCE: '../shared' }), /BOXLITE_E2E_INSTANCE/)
  assert.throws(() => buildLocalDexConfig({ BOXLITE_E2E_API_PORT: 'not-a-port' }), /BOXLITE_E2E_API_PORT/)
})

test('runs the headless Nx workspace from the apps directory', () => {
  const command = buildAppsCommand(buildLocalDexConfig({ BOXLITE_E2E_HEADLESS: 'true' }))

  assert.match(command.program, /apps\/node_modules\/\.bin\/nx$/)
  assert.equal(command.cwd.endsWith('/apps'), true)
  assert.deepEqual(command.args.slice(0, 3), ['run-many', '--target=serve', '--projects=api,runner,proxy'])
})
