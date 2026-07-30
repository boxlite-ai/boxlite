// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../sst.config.ts', import.meta.url), 'utf8')
const environmentExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('loads local helpers dynamically inside SST config callbacks', () => {
  assert.doesNotMatch(source, /^import\s/m)
  assert.match(source, /async app\(input\)/)
  assert.match(source, /await import\('\.\/scripts\/deployment-environment\.mjs'\)/)
})

test('does not force a laptop-managed remote builder', () => {
  const appSource = source.slice(source.indexOf('async app(input)'), source.indexOf('async run()'))

  assert.doesNotMatch(appSource, /buildx-builder/)
  assert.doesNotMatch(appSource, /BUILDX_BUILDER/)
  assert.doesNotMatch(environmentExample, /^BUILDX_BUILDER_/m)
})

test('pins the AWS provider used by the deployed stack', () => {
  assert.match(source, /aws:\s*\{\s*version: '7\.24\.0',\s*region: REGION,/)
})

test('applies the deployment permissions boundary to every SST-created IAM role', () => {
  assert.match(source, /const runtimePermissionsBoundaryArn =/)
  assert.match(source, /requireIamPermissionsBoundaryStage\(\$app\.stage\)/)
  assert.match(environmentExample, /^IAM_PERMISSIONS_BOUNDARY_STAGE=dev$/m)
  assert.match(
    source,
    /\$transform\(aws\.iam\.Role,[\s\S]*args\.permissionsBoundary \?\?= runtimePermissionsBoundaryArn/,
  )
})

test('uses the shared AWS region resolver and waits for the critical API service', () => {
  assert.match(
    source,
    /const \{[^}]*resolveAwsRegion[^}]*\} = await import\('\.\/scripts\/deployment-environment\.mjs'\)/,
  )
  assert.match(source, /const REGION = resolveAwsRegion\(\)/)

  const apiService = source.slice(
    source.indexOf("const api = new sst.aws.Service('Api'"),
    source.indexOf('// Assumed by the Api task role'),
  )
  assert.match(apiService, /wait: true,/)
})

test('uses the canonical deployment config for every Proxy-facing SST value', () => {
  const runSource = source.slice(source.indexOf('async run()'), source.indexOf('// ── runner bootstrap'))

  assert.match(runSource, /resolvePublicDeploymentConfig/)
  assert.match(runSource, /const deploymentConfig = resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(runSource, /const \{ stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion \}/)
  assert.doesNotMatch(runSource, /envOr\('PROXY_(?:DOMAIN|PROTOCOL|TEMPLATE_URL)'/)
})

test('keeps the AWS region in run scope and passes it into Runner user data', () => {
  const runSource = source.slice(source.indexOf('async run()'), source.indexOf('// ── runner bootstrap'))
  const runnerUserDataSource = source.slice(source.indexOf('async function buildRunnerUserData'))

  assert.match(runSource, /const REGION = resolveAwsRegion\(\)/)
  assert.equal(runSource.match(/awsRegion: REGION/g)?.length, 2)
  assert.match(runnerUserDataSource, /awsRegion: string/)
  assert.match(runnerUserDataSource, /Environment=AWS_REGION=\$\{input\.awsRegion\}/)
})

test('tags Runner instances with their exact control-plane identity', () => {
  const runnerResources = source.slice(
    source.indexOf('const makeRunner ='),
    source.indexOf('// Register the extra runners'),
  )

  assert.match(runnerResources, /'boxlite:control-plane-runner-name': controlPlaneRunnerName/)
  assert.match(runnerResources, /makeRunner\('Runner', 'boxlite-runner-default', defaultRunnerName, runnerUserData\)/)
  assert.match(runnerResources, /`boxlite-runner-\$\{index\}`,[\s\S]*name,[\s\S]*buildRunnerUserData/)
})

test('passes both the internal and public OIDC issuers to Proxy', () => {
  const proxyService = source.slice(source.indexOf("new sst.aws.Service('Proxy'"), source.indexOf('// ─── 8.'))

  assert.match(proxyService, /OIDC_DOMAIN: oidcIssuer,/)
  assert.match(proxyService, /publicOidcIssuer[\s\S]*OIDC_PUBLIC_DOMAIN: publicOidcIssuer/)
})

test('requires the OIDC client ID through the SST secret store', () => {
  assert.match(source, /new sst\.Secret\('OIDC_CLIENT_ID'\)/)
  assert.doesNotMatch(source, /new sst\.Secret\('OIDC_CLIENT_ID',/)
  assert.doesNotMatch(environmentExample, /^OIDC_CLIENT_ID=/m)

  const quickStart = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Secrets & credentials'))
  assert.match(quickStart, /npm run sst -- secret set OIDC_CLIENT_ID/)
  assert.doesNotMatch(quickStart, /App secrets .* are optional/)
})

test('does not restore the removed SSH gateway deployment', () => {
  assert.doesNotMatch(source, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(environmentExample, /SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(readme, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
})

test('passes explicit management API endpoints into the API service', () => {
  const apiService = source.slice(
    source.indexOf("const api = new sst.aws.Service('Api'"),
    source.indexOf('// Assumed by the Api task role'),
  )

  assert.match(apiService, /OIDC_MANAGEMENT_API_BASE_URL: process\.env\.OIDC_MANAGEMENT_API_BASE_URL/)
  assert.match(apiService, /OIDC_MANAGEMENT_API_TOKEN_URL: process\.env\.OIDC_MANAGEMENT_API_TOKEN_URL/)
})

test('reports the canonical workspace release unless VERSION overrides it', () => {
  assert.match(source, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(source, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(source, /proxyTemplateUrl, releaseVersion \} = deploymentConfig/)

  const apiService = source.slice(
    source.indexOf("const api = new sst.aws.Service('Api'"),
    source.indexOf('// Assumed by the Api task role'),
  )
  assert.match(apiService, /VERSION: releaseVersion,/)
})

test('Runner bootstrap fails closed when the release checksum is unavailable', () => {
  const runnerBootstrap = source.slice(source.indexOf('async function buildRunnerUserData'))

  assert.doesNotMatch(runnerBootstrap, /if curl -fsSL .*\.sha256/)
  assert.match(runnerBootstrap, /curl -fsSL .*\.sha256.*-o \/tmp\/runner\.sha256/)
  assert.match(runnerBootstrap, /runner checksum mismatch/)
})
