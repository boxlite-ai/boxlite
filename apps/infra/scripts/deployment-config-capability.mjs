// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  DEPLOYMENT_CONFIG_RELEASE_ENV,
  DEPLOYMENT_CONFIG_SCHEMA_VERSION,
} from './deployment-config.mjs'
import { resolveAndInjectDeploymentConfig } from './deployment-config-loader.mjs'
import { liveText } from './live-source.mjs'
import { classifySstCommand } from './sst-command-contract.mjs'

const RELEASE_ID = 'a'.repeat(64)

function requireCapability(condition, message) {
  if (!condition) throw new Error(message)
}

export function verifyDeploymentConfigCapability({
  wrapperSource = readFileSync(new URL('./sst-with-cloudflare.mjs', import.meta.url), 'utf8'),
} = {}) {
  requireCapability(DEPLOYMENT_CONFIG_SCHEMA_VERSION === 1, 'deployment config schema v1 is unavailable')

  const calls = []
  const environment = {
    [DEPLOYMENT_CONFIG_RELEASE_ENV]: RELEASE_ID,
    STACK_DOMAIN: 'ambient.example.test',
  }
  const release = {
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
  const resolved = resolveAndInjectDeploymentConfig({
    stage: 'dev',
    region: 'ap-southeast-1',
    awsCliPath: '/credential-free-capability-probe',
    environment,
    createStore(options) {
      calls.push({ operation: 'create', options })
      return {
        resolve(selection) {
          calls.push({ operation: 'resolve', selection })
          return release
        },
      }
    },
  })
  requireCapability(resolved === release, 'composed loader did not return the selected release')
  requireCapability(
    calls.length === 2 && calls[0].operation === 'create' && calls[1].operation === 'resolve',
    'composed loader did not construct and resolve exactly one store',
  )
  requireCapability(calls[1].selection.releaseId === RELEASE_ID, 'composed loader did not preserve the pinned release')
  requireCapability(environment.STACK_DOMAIN === 'dev.example.test', 'composed loader did not inject the release')
  requireCapability(environment.SST_STAGE === 'dev', 'composed loader did not inject the selected stage')

  const diff = classifySstCommand(['diff', '--stage', 'dev'])
  const remove = classifySstCommand(['remove', '--stage', 'dev'])
  const refresh = classifySstCommand(['refresh', '--stage', 'dev'])
  const shell = classifySstCommand(['shell', '--stage', 'dev'])
  const install = classifySstCommand(['install', '--stage', 'ci'])
  requireCapability(
    diff.needsDeploymentConfig &&
      diff.needsProviderCredentials &&
      diff.needsStackPreflight &&
      diff.needsRunnerStateBaseline,
    'diff is not protected by the full deployment command contract',
  )
  requireCapability(
    [remove, refresh, shell].every(
      (command) =>
        command.needsDeploymentConfig &&
        command.needsProviderCredentials &&
        !command.needsStackPreflight &&
        command.needsRunnerStateBaseline,
    ),
    'a stack-evaluating maintenance command does not load the Runner state baseline',
  )
  requireCapability(
    !install.needsDeploymentConfig &&
      !install.needsProviderCredentials &&
      !install.needsStackPreflight &&
      !install.needsRunnerStateBaseline,
    'install is not deployment-config and AWS independent',
  )
  for (const args of [['secret', 'list', '--stage', 'dev'], ['unclassified-command']]) {
    let rejected = false
    try {
      classifySstCommand(args)
    } catch {
      rejected = true
    }
    requireCapability(rejected, `${args.join(' ')} bypasses the reviewed command matrix`)
  }

  const liveWrapper = liveText('script', wrapperSource)
  requireCapability(
    /import\s*\{\s*resolveAndInjectDeploymentConfig\s*\}\s*from\s*['"]\.\/deployment-config-loader\.mjs['"]/.test(
      liveWrapper,
    ),
    'SST wrapper does not import the composed deployment config loader',
  )
  requireCapability(
    /resolveAndInjectDeploymentConfig\(\{/.test(liveWrapper),
    'SST wrapper does not call the composed deployment config loader',
  )
  requireCapability(
    !/\binjectDeploymentConfigEnvironment\b/.test(liveWrapper) &&
      !/\.(?:resolve|readRelease|prepare|prepareDocument|publish|activate|putCurrent|putRelease)\s*\(/.test(liveWrapper),
    'SST wrapper bypasses the composed deployment config loader',
  )
  requireCapability(
    !/from\s*['"]dotenv(?:\/config)?['"]|import\(['"]dotenv(?:\/config)?['"]\)|loadDeploymentEnvironment|loadBootstrapEnvironment/.test(
      liveWrapper,
    ),
    'SST wrapper still has a routine dotenv path',
  )
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    verifyDeploymentConfigCapability()
    console.log('deployment-config-capability: supported')
  } catch (error) {
    console.error(`deployment-config-capability: ${error.message}`)
    process.exitCode = 1
  }
}
