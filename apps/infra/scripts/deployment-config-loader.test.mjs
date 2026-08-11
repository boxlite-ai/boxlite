// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAndInjectDeploymentConfig } from './deployment-config-loader.mjs'

const RELEASE_ID = 'a'.repeat(64)
const RELEASE = {
  releaseId: RELEASE_ID,
  document: {
    accountId: '123456789012',
    region: 'ap-southeast-1',
    schemaVersion: 1,
    stage: 'dev',
    values: {
      BOXLITE_RUNTIME_SECRET_GENERATIONS: {
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
      },
      OIDC_AUDIENCE: 'boxlite-api',
      OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
      STACK_DOMAIN: 'dev.example.test',
    },
  },
}

test('composes one pinned store resolution directly into in-memory environment injection', () => {
  const calls = []
  const environment = {
    BOXLITE_DEPLOY_CONFIG_RELEASE: RELEASE_ID,
    STACK_DOMAIN: 'ambient.example.test',
  }

  const result = resolveAndInjectDeploymentConfig({
    stage: 'dev',
    region: 'ap-southeast-1',
    awsCliPath: '/synthetic/aws',
    environment,
    createStore(options) {
      calls.push({ operation: 'create', options })
      return {
        resolve(selection) {
          calls.push({ operation: 'resolve', selection })
          assert.equal(environment.STACK_DOMAIN, 'ambient.example.test', 'injection must follow resolution')
          return RELEASE
        },
      }
    },
  })

  assert.equal(result, RELEASE)
  assert.deepEqual(calls, [
    {
      operation: 'create',
      options: { awsCliPath: '/synthetic/aws', region: 'ap-southeast-1' },
    },
    {
      operation: 'resolve',
      selection: { stage: 'dev', releaseId: RELEASE_ID },
    },
  ])
  assert.equal(environment.STACK_DOMAIN, 'dev.example.test')
  assert.equal(environment.AWS_REGION, 'ap-southeast-1')
  assert.equal(environment.SST_STAGE, 'dev')
  assert.equal(environment.BOXLITE_DEPLOY_CONFIG_RELEASE, RELEASE_ID)
})

test('rejects malformed selection before constructing a store', () => {
  const createStore = () => assert.fail('invalid selection must not construct a deployment config store')

  assert.throws(
    () =>
      resolveAndInjectDeploymentConfig({
        stage: '../prod',
        region: 'ap-southeast-1',
        awsCliPath: '/synthetic/aws',
        environment: {},
        createStore,
      }),
    /stage/i,
  )
  assert.throws(
    () =>
      resolveAndInjectDeploymentConfig({
        stage: 'dev',
        region: 'ap-southeast-1',
        awsCliPath: '/synthetic/aws',
        environment: { BOXLITE_DEPLOY_CONFIG_RELEASE: ` ${RELEASE_ID}` },
        createStore,
      }),
    /surrounding whitespace/i,
  )
})
