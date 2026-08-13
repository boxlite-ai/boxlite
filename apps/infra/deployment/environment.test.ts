// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadDeploymentEnvironment,
  readWorkspaceVersion,
  resolveAwsRegion,
  resolvePublicDeploymentConfig,
  resolveReleaseVersion,
} from './environment.js'

test('loads the deployment dotenv before resolving wrapper-side AWS settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-deployment-environment-'))
  const dotenvPath = join(directory, '.env')
  const environment: NodeJS.ProcessEnv = { AWS_REGION: 'eu-west-1' }
  writeFileSync(dotenvPath, 'AWS_REGION=ap-southeast-2\nAWS_CLI_PATH=/custom/bin/aws\nSST_STAGE=staging\n')

  try {
    loadDeploymentEnvironment({ path: dotenvPath, environment })

    assert.equal(resolveAwsRegion(environment), 'eu-west-1', 'the shell environment must override .env')
    assert.equal(environment.AWS_CLI_PATH, '/custom/bin/aws')
    assert.equal(environment.SST_STAGE, 'staging')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('uses one AWS region resolver for the wrapper and SST config', () => {
  assert.equal(resolveAwsRegion({}), 'ap-southeast-1')
  assert.equal(resolveAwsRegion({ AWS_REGION: ' us-east-2 ' }), 'us-east-2')
})

test('finds the workspace version when SST runs a bundle below .sst/platform', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'boxlite-bundled-sst-'))
  const bundledModuleDirectory = join(repositoryRoot, 'apps', 'infra', '.sst', 'platform')

  try {
    mkdirSync(bundledModuleDirectory, { recursive: true })
    writeFileSync(join(repositoryRoot, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\n')
    writeFileSync(join(repositoryRoot, 'apps', 'Cargo.toml'), '[workspace.package]\nversion = "9.9.9"\n')
    writeFileSync(
      join(repositoryRoot, 'apps', 'infra', 'package.json'),
      JSON.stringify({ name: '@boxlite/infra', private: true }),
    )

    assert.equal(readWorkspaceVersion({ moduleDirectory: bundledModuleDirectory }), '1.2.3')
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true })
  }
})

test('fails explicitly when no ancestor contains both repository markers', () => {
  const incompleteRepository = mkdtempSync(join(tmpdir(), 'boxlite-incomplete-repository-'))
  const moduleDirectory = join(incompleteRepository, '.sst', 'platform')

  try {
    mkdirSync(moduleDirectory, { recursive: true })
    writeFileSync(join(incompleteRepository, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\n')

    assert.throws(
      () => readWorkspaceVersion({ moduleDirectory }),
      /could not find the BoxLite repository root.*Cargo\.toml.*apps\/infra\/package\.json/,
    )
  } finally {
    rmSync(incompleteRepository, { recursive: true, force: true })
  }
})

test('uses a stable workspace release as the API version unless explicitly overridden', () => {
  assert.equal(resolveReleaseVersion('0.9.7', {}), '0.9.7')
  assert.equal(resolveReleaseVersion('0.9.7', { VERSION: '0.9.8' }), '0.9.8')
  assert.throws(() => resolveReleaseVersion('  ', {}), /workspace release version is missing/)
})

test('rejects non-stable or whitespace-normalized release identities', () => {
  for (const workspaceVersion of [' 0.9.7 ', 'v0.9.7', '0.9', '0.9.7-rc.1', '01.2.3']) {
    assert.throws(() => resolveReleaseVersion(workspaceVersion, {}), /stable semantic version/)
  }
  for (const version of [' 0.9.8 ', 'latest', '0.9.8+build.1', '0.9.8-rc.1', '1.02.3']) {
    assert.throws(() => resolveReleaseVersion('0.9.7', { VERSION: version }), /stable semantic version/)
  }
})

test('derives the public deployment probes from the same deployment environment', () => {
  assert.deepEqual(
    resolvePublicDeploymentConfig(
      {
        STACK_DOMAIN: 'dev.boxlite.ai',
        PROXY_DOMAIN: 'preview.dev.boxlite.ai',
        PROXY_PROTOCOL: 'https',
        PROXY_TEMPLATE_URL: 'https://preview.dev.boxlite.ai',
        OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/',
        PUBLIC_OIDC_DOMAIN: 'https://auth.dev.boxlite.ai/',
        BOXLITE_SYSTEM_IMAGES:
          'sandbaseai-hermes=sam2026go/hermes-agent:boxlite-noexpose-20260726,tools=example.test/tools:1',
      },
      '0.9.7',
    ),
    {
      stackDomain: 'dev.boxlite.ai',
      proxyDomain: 'preview.dev.boxlite.ai',
      proxyProtocol: 'https',
      proxyTemplateUrl: 'https://preview.dev.boxlite.ai',
      releaseVersion: '0.9.7',
      proxyHealthUrl: 'https://preview.dev.boxlite.ai/health',
      proxyWildcardHealthUrl: 'https://deployment-probe.preview.dev.boxlite.ai/health',
      apiConfigUrl: 'https://api.dev.boxlite.ai/api/config',
      expectedOidcIssuer: 'https://auth.dev.boxlite.ai/',
      expectedProxyTemplateUrl: 'https://preview.dev.boxlite.ai',
      expectedVersion: '0.9.7',
    },
  )
})

test('rejects malformed deployment image additions before SST can mutate the stack', () => {
  const baseEnvironment = {
    STACK_DOMAIN: 'dev.boxlite.ai',
    OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/',
  }

  for (const configuredImages of ['missing-ref=', '=missing-name', 'missing-separator']) {
    assert.throws(
      () =>
        resolvePublicDeploymentConfig(
          {
            ...baseEnvironment,
            BOXLITE_SYSTEM_IMAGES: configuredImages,
          },
          '0.9.7',
        ),
      /Invalid BOXLITE_SYSTEM_IMAGES entry.*expected 'name=ref'/,
    )
  }
})

test('returns canonical Proxy settings for SST and the public verifier', () => {
  const config = resolvePublicDeploymentConfig(
    {
      STACK_DOMAIN: 'DEV.BOXLITE.AI',
      PROXY_DOMAIN: ' Preview.Dev.BoxLite.AI ',
      PROXY_PROTOCOL: ' https ',
      PROXY_TEMPLATE_URL: ' https://Preview.Dev.BoxLite.AI/ ',
      OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/',
    },
    '0.9.7',
  )

  assert.equal(config.stackDomain, 'dev.boxlite.ai')
  assert.equal(config.proxyDomain, 'preview.dev.boxlite.ai')
  assert.equal(config.proxyProtocol, 'https')
  assert.equal(config.proxyTemplateUrl, 'https://preview.dev.boxlite.ai')
  assert.equal(config.proxyHealthUrl, 'https://preview.dev.boxlite.ai/health')
  assert.equal(config.proxyWildcardHealthUrl, 'https://deployment-probe.preview.dev.boxlite.ai/health')
})

test('rejects Proxy settings that disagree with the provisioned TLS NLB', () => {
  const baseEnvironment = {
    STACK_DOMAIN: 'dev.boxlite.ai',
    OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/',
  }

  assert.throws(
    () =>
      resolvePublicDeploymentConfig(
        {
          ...baseEnvironment,
          PROXY_PROTOCOL: 'http',
        },
        '0.9.7',
      ),
    /PROXY_PROTOCOL must be https/,
  )
  assert.throws(
    () =>
      resolvePublicDeploymentConfig(
        {
          ...baseEnvironment,
          PROXY_DOMAIN: 'proxy.dev.boxlite.ai',
          PROXY_TEMPLATE_URL: 'https://detached.dev.boxlite.ai',
        },
        '0.9.7',
      ),
    /PROXY_TEMPLATE_URL host detached\.dev\.boxlite\.ai does not match PROXY_DOMAIN proxy\.dev\.boxlite\.ai/,
  )
})
