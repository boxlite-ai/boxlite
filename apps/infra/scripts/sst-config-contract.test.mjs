// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../sst.config.ts', import.meta.url), 'utf8')
const environmentExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

function extractSection(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  if (endMarker === undefined) return contents.slice(start)

  const end = contents.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  assert.ok(end > start, `end marker must follow start marker: ${endMarker}`)
  return contents.slice(start, end)
}

test('loads local helpers dynamically inside SST config callbacks', () => {
  assert.doesNotMatch(source, /^import\s/m)
  assert.match(source, /async app\(input\)/)
  assert.match(source, /await import\('\.\/scripts\/deployment-environment\.mjs'\)/)
})

test('does not force a laptop-managed remote builder', () => {
  const appSource = extractSection(source, 'async app(input)', 'async run()')

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

  const apiService = extractSection(source, "const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /wait: true,/)
})

test('uses the canonical deployment config for every Proxy-facing SST value', () => {
  const runSource = extractSection(source, 'async run()', '// ── runner bootstrap')

  assert.match(runSource, /resolvePublicDeploymentConfig/)
  assert.match(runSource, /const deploymentConfig = resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(runSource, /const \{ stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion \}/)
  assert.doesNotMatch(runSource, /envOr\('PROXY_(?:DOMAIN|PROTOCOL|TEMPLATE_URL)'/)
})

test('keeps the AWS region in run scope and passes it into Runner user data', () => {
  const runSource = extractSection(source, 'async run()', '// ── runner bootstrap')
  const runnerUserDataSource = extractSection(source, 'async function buildRunnerUserData')

  assert.match(runSource, /const REGION = resolveAwsRegion\(\)/)
  assert.equal(runSource.match(/awsRegion: REGION/g)?.length, 2)
  assert.match(runnerUserDataSource, /awsRegion: string/)
  assert.match(runnerUserDataSource, /Environment=AWS_REGION=\$\{input\.awsRegion\}/)
})

test('tags Runner instances with their exact control-plane identity', () => {
  const runnerResources = extractSection(source, 'const makeRunner =', '// Register the extra runners')

  assert.match(source, /import\('\.\/scripts\/runner-inventory\.cjs'\)/)
  assert.match(source, /const runnerInventory = resolveRunnerInventory\(process\.env\)/)
  assert.match(runnerResources, /'boxlite:control-plane-runner-name': controlPlaneRunnerName/)
  assert.match(
    runnerResources,
    /makeRunner\([\s\S]*defaultRunnerConfig\.resourceName,[\s\S]*defaultRunnerConfig\.nameTag,[\s\S]*defaultRunnerConfig\.controlPlaneRunnerName,[\s\S]*runnerUserData/,
  )
  assert.match(runnerResources, /runnerInventory\.slice\(1\)\.map\([\s\S]*runner\.nameTag,[\s\S]*buildRunnerUserData/)
})

test('keeps every Runner instance protected from replacement during full-stack deploys', () => {
  const runnerFactory = extractSection(source, 'const makeRunner =', '// Default runner')

  assert.match(runnerFactory, /new aws\.ec2\.Instance\(/)
  assert.match(runnerFactory, /ignoreChanges: \['ami', 'userDataBase64'\]/)
  assert.match(runnerFactory, /protect: true/)
  assert.equal(source.match(/new aws\.ec2\.Instance\(/g)?.length, 1)
})

test('passes both the internal and public OIDC issuers to Proxy', () => {
  const proxyService = extractSection(source, "new sst.aws.Service('Proxy'", '// ─── 8.')

  assert.match(proxyService, /OIDC_DOMAIN: oidcIssuer,/)
  assert.match(proxyService, /publicOidcIssuer[\s\S]*OIDC_PUBLIC_DOMAIN: publicOidcIssuer/)
})

test('requires the OIDC client ID through the SST secret store', () => {
  assert.match(source, /new sst\.Secret\('OIDC_CLIENT_ID'\)/)
  assert.doesNotMatch(source, /new sst\.Secret\('OIDC_CLIENT_ID',/)
  assert.doesNotMatch(environmentExample, /^OIDC_CLIENT_ID=/m)

  const deploymentGuide = extractSection(readme, '## Deploy an existing stack', '## Secrets & credentials')
  assert.match(deploymentGuide, /npm run bootstrap/)
  assert.match(deploymentGuide, /OIDC_CLIENT_ID/)
  assert.doesNotMatch(deploymentGuide, /App secrets .* are optional/)
  for (const documentation of [readme, environmentExample]) {
    assert.doesNotMatch(documentation, /secret set (?:[A-Z_]+|<NAME>)\s+["']?<[^>\n]+>["']?\s+--stage/)
  }
})

test('data-protection guards key off the stage that actually exists: prod', () => {
  // SST state has app/boxlite/prod.json and no production.json — the real
  // stage is `prod`. The deployed prod stack carries retainOnDelete and
  // deletionProtection because it was deployed from a branch that already
  // compared against 'prod'; main still said 'production', so deploying prod
  // from main would have computed isProd === false and reset them. One
  // constant, both call sites, so the two guards cannot drift apart again.
  assert.match(source, /const PRODUCTION_STAGE = 'prod'/)
  assert.match(source, /removal: input\?\.stage === PRODUCTION_STAGE \? 'retain' : 'remove'/)
  assert.match(source, /const isProd = \$app\.stage === PRODUCTION_STAGE/)
})

test('no stage-name comparison hardcodes a bare production literal', () => {
  // NODE_ENV / ENVIRONMENT: 'production' are Node runtime values, not stages,
  // and must survive; a stage comparison against the string must not.
  assert.doesNotMatch(source, /stage === 'production'/)
  assert.doesNotMatch(source, /stage === "production"/)
  assert.match(source, /NODE_ENV: 'production'/)
})

test('the prod stage keeps deletion protection and a final snapshot', () => {
  assert.match(source, /args\.deletionProtection = isProd/)
  assert.match(source, /args\.skipFinalSnapshot = !isProd/)
})

test('does not restore the removed SSH gateway deployment', () => {
  assert.doesNotMatch(source, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(environmentExample, /SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(readme, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
})

test('passes explicit management API endpoints into the API service', () => {
  const apiService = extractSection(source, "const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')

  assert.match(apiService, /OIDC_MANAGEMENT_API_BASE_URL: process\.env\.OIDC_MANAGEMENT_API_BASE_URL/)
  assert.match(apiService, /OIDC_MANAGEMENT_API_TOKEN_URL: process\.env\.OIDC_MANAGEMENT_API_TOKEN_URL/)
})

test('reports the canonical workspace release unless VERSION overrides it', () => {
  assert.match(source, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(source, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(source, /proxyTemplateUrl, releaseVersion \} = deploymentConfig/)

  const apiService = extractSection(source, "const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /VERSION: releaseVersion,/)
})

test('Runner bootstrap fails closed when the release checksum is unavailable', () => {
  const runnerBootstrap = extractSection(source, 'async function buildRunnerUserData')

  assert.doesNotMatch(runnerBootstrap, /if curl -fsSL .*\.sha256/)
  assert.match(runnerBootstrap, /curl -fsSL .*\.sha256.*-o \/tmp\/runner\.sha256/)
  assert.match(runnerBootstrap, /runner checksum mismatch/)
})

test('upgrades every Runner through a dependsOn chain, one host per command', () => {
  // The chain is the only thing sequencing the restarts, and it cannot be observed
  // without a real deploy — so it is pinned here, next to the other deploy-shape
  // invariants, rather than left to prose.
  const upgrades = extractSection(source, '── Rolling runner binary upgrade')

  // Every Runner gets a command: the default (captured for exactly this) plus each extra.
  assert.match(source, /const defaultRunner = makeRunner\(/)
  assert.match(upgrades, /\{ label: 'default', instance: defaultRunner \}/)
  assert.match(upgrades, /\.\.\.extraRunners\.map\(\(r\) => \(\{ label: r\.name, instance: r\.instance \}\)\)/)
  assert.match(upgrades, /new command\.local\.Command\(\s*`UpgradeRunnerBinary-\$\{label\}`/)

  // Each command waits on the previous one, so two Runners never restart at once.
  assert.match(upgrades, /previousUpgrade = new command\.local\.Command/)
  assert.match(upgrades, /dependsOn: previousUpgrade \? \[instance, previousUpgrade\] : \[instance\]/)

  // Exactly one host per command, and a version bump is what re-runs it.
  assert.match(upgrades, /INSTANCE_IDS: instance\.id/)
  assert.match(upgrades, /triggers: \[workspaceVersion, instance\.id\]/)
  // `triggers` replaces the resource, so `create` must carry the same body as `update`.
  assert.match(
    upgrades,
    /create: 'node scripts\/runner-update-binary\.mjs',\s*update: 'node scripts\/runner-update-binary\.mjs',/,
  )
})

test('no longer points operators at the deleted shell updater', () => {
  assert.doesNotMatch(source, /scripts\/deploy\/runner-update-binary\.sh/)
  assert.doesNotMatch(readme, /runner-update-binary\.sh/)
  assert.match(readme, /scripts\/runner-update-binary\.mjs/)
})
