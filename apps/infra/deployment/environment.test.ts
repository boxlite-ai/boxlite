// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadDeploymentEnvironment,
  optionalPublicOidcIssuer,
  readWorkspaceVersion,
  requireIamPermissionsBoundaryStage,
  requireOidcIssuer,
  resolveAwsRegion,
  resolveMailDomain,
  resolvePublicDeploymentConfig,
  sesSmtpEndpoint,
  resolveReleaseVersion,
  resolveSstStage,
  runtimeBoundaryPolicyArn,
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

test('resolves one sender domain for the deploy and for bootstrap', () => {
  // bootstrap pins the SMTP user's IAM policy to this identity's ARN and the stack
  // verifies it, so a disagreement between the two mints a credential whose every
  // send is refused — with nothing failing until the first invitation.
  assert.equal(resolveMailDomain({}), 'mail.boxlite.ai')
  assert.equal(resolveMailDomain({ MAIL_DOMAIN: ' mail.dev.boxlite.ai ' }), 'mail.dev.boxlite.ai')

  // The Api sends as no-reply@<MAIL_DOMAIN>, so an address or a URL here would build
  // a From that SES refuses, and an empty value would silently take the default.
  assert.throws(() => resolveMailDomain({ MAIL_DOMAIN: 'no-reply@mail.boxlite.ai' }), /MAIL_DOMAIN/)
  assert.throws(() => resolveMailDomain({ MAIL_DOMAIN: 'https://mail.boxlite.ai' }), /MAIL_DOMAIN/)
  assert.equal(resolveMailDomain({ MAIL_DOMAIN: '' }), 'mail.boxlite.ai')
})

test('addresses one regional SMTP endpoint for the deploy and for bootstrap', () => {
  // The SMTP password is derived per region, so a host from one region and a
  // credential from another authenticate nowhere — the stack and bootstrap have to
  // build this the same way.
  assert.equal(sesSmtpEndpoint('ap-southeast-1'), 'email-smtp.ap-southeast-1.amazonaws.com')
  assert.notEqual(sesSmtpEndpoint('us-west-1'), sesSmtpEndpoint('ap-southeast-1'))
  assert.throws(() => sesSmtpEndpoint(''), /region/)
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

test('resolves a stage from separate and inline CLI arguments', () => {
  assert.equal(resolveSstStage(['deploy', '--stage', 'dev'], {}), 'dev')
  assert.equal(resolveSstStage(['deploy', '--stage=production'], {}), 'production')
})

test('resolves an explicitly configured SST_STAGE', () => {
  assert.equal(resolveSstStage(['deploy'], { SST_STAGE: 'staging' }), 'staging')
})

test('rejects duplicate stage options instead of guessing which one SST will use', () => {
  assert.throws(
    () => resolveSstStage(['deploy', '--stage', 'dev', '--stage=production'], {}),
    /--stage may be specified only once/,
  )
})

test('rejects unsafe CLI and environment stage values', () => {
  for (const stage of ['dev/production', ' dev', 'dev ', '--production', 'Feature', 'feature_42-test', 'a'.repeat(29), '']) {
    if (stage === '') {
      assert.throws(() => resolveSstStage(['deploy', '--stage='], {}), /--stage requires a value/)
      continue
    }
    assert.throws(() => resolveSstStage(['deploy', `--stage=${stage}`], {}), /invalid SST stage/)
  }

  assert.throws(() => resolveSstStage(['deploy'], { SST_STAGE: 'dev/production' }), /invalid SST stage/)
  assert.equal(resolveSstStage(['deploy', '--stage', `feature-${'a'.repeat(20)}`], {}), `feature-${'a'.repeat(20)}`)
})

test('requires an explicit stage for state-changing stack commands', () => {
  assert.throws(() => resolveSstStage(['deploy'], {}), /deploy requires an explicit --stage or SST_STAGE/)
  assert.throws(() => resolveSstStage(['remove'], {}), /remove requires an explicit --stage or SST_STAGE/)
})

test('retains the dev credential lookup default for non-deploy commands', () => {
  assert.equal(resolveSstStage(['diff'], {}), 'dev')
})

test('requires the provisioned IAM boundary stage to match the SST stage', () => {
  assert.equal(requireIamPermissionsBoundaryStage('dev', { IAM_PERMISSIONS_BOUNDARY_STAGE: 'dev' }), 'dev')
  assert.throws(
    () => requireIamPermissionsBoundaryStage(0, { IAM_PERMISSIONS_BOUNDARY_STAGE: '0' }),
    /invalid SST stage/,
  )
  assert.throws(
    () => requireIamPermissionsBoundaryStage('production', { IAM_PERMISSIONS_BOUNDARY_STAGE: 'dev' }),
    /IAM permissions boundary stage dev does not match SST stage production/,
  )
  assert.throws(() => requireIamPermissionsBoundaryStage('dev', {}), /IAM_PERMISSIONS_BOUNDARY_STAGE is required/)
})

test('runtimeBoundaryPolicyArn matches the stack transform interpolation', () => {
  assert.equal(
    runtimeBoundaryPolicyArn({ accountId: '123456789012', appName: 'boxlite', stage: 'dev' }),
    'arn:aws:iam::123456789012:policy/boxlite-dev-runtime-boundary',
  )
})

test('runtimeBoundaryPolicyArn rejects a malformed account id and an unsafe stage', () => {
  assert.throws(
    () => runtimeBoundaryPolicyArn({ accountId: '12345', appName: 'boxlite', stage: 'dev' }),
    /must be a 12-digit AWS account id/,
  )
  // Tightened by the move: this name is interpolated into an ARN, so it now takes the same stage
  // grammar every other generated name does rather than the looser bootstrap-side spelling. 'Dev'
  // is the case that shows the change — the old grammar allowed uppercase and accepted it.
  assert.throws(
    () => runtimeBoundaryPolicyArn({ accountId: '123456789012', appName: 'boxlite', stage: 'Dev' }),
    /invalid SST stage/,
  )
})

test('preserves each provider-defined HTTPS issuer exactly', () => {
  assert.equal(requireOidcIssuer({ OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/' }), 'https://tenant.auth0.com/')
  assert.equal(
    requireOidcIssuer({ OIDC_ISSUER_BASE_URL: 'https://tenant.okta.com/oauth2/default' }),
    'https://tenant.okta.com/oauth2/default',
  )
  assert.equal(
    optionalPublicOidcIssuer({ PUBLIC_OIDC_DOMAIN: 'https://auth.dev.example.com/tenant' }),
    'https://auth.dev.example.com/tenant',
  )
})

test('requires the internal issuer and treats an empty public issuer as unset', () => {
  assert.throws(() => requireOidcIssuer({}), /OIDC_ISSUER_BASE_URL is required/)
  assert.equal(optionalPublicOidcIssuer({}), undefined)
  assert.equal(optionalPublicOidcIssuer({ PUBLIC_OIDC_DOMAIN: '' }), undefined)
})

test('rejects malformed or unsafe issuer URLs', () => {
  for (const value of [
    'tenant.auth0.com/',
    'http://tenant.auth0.com/',
    'https://user:password@tenant.auth0.com/',
    'https://tenant.auth0.com/?tenant=dev',
    'https://tenant.auth0.com/#issuer',
  ]) {
    assert.throws(() => requireOidcIssuer({ OIDC_ISSUER_BASE_URL: value }), /OIDC_ISSUER_BASE_URL/)
  }
})
