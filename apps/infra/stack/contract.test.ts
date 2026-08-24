// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { liveText } from '../shared/live-source.js'

const entrypointSource = readFileSync(new URL('../sst.config.ts', import.meta.url), 'utf8')
const stackSource = [
  readFileSync(new URL('./app.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./settings.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./deploy.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./foundation.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./clickhouse.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./observability.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./api.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./edge.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./runners.ts', import.meta.url), 'utf8'),
].join('\n')
const source = `${entrypointSource}\n${stackSource}`
const environmentExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const infraLocalNative = readFileSync(new URL('../../infra-local/compose/native.py', import.meta.url), 'utf8')
const readme = [
  readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
  readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8'),
].join('\n')

// Every assertion over sst.config.ts in this file pins behavior, so the decision to strip both
// comment syntaxes is made here, once, rather than at each call site — a call site that reaches
// for the weaker stripper (or none) gets a guard that keeps passing over commented-out code.
// Markers are located in the raw text because several of them are themselves comments. A very
// few assertions read `source` on purpose, where what they pin IS a comment; each says so.
const configSection = (startMarker: string, endMarker?: string) =>
  liveText('scriptEmittingShell', extractSection(source, startMarker, endMarker))
const liveConfig = liveText('scriptEmittingShell', source)

function extractSection(contents: string, startMarker: string, endMarker?: string) {
  const start = contents.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  if (endMarker === undefined) return contents.slice(start)

  const end = contents.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  assert.ok(end > start, `end marker must follow start marker: ${endMarker}`)
  return contents.slice(start, end)
}

test('loads local helpers dynamically inside SST config callbacks', () => {
  const liveEntrypoint = liveText('scriptEmittingShell', entrypointSource)
  assert.doesNotMatch(liveEntrypoint, /^import\s/m)
  assert.match(liveEntrypoint, /async app\(input\)/)
  assert.match(liveEntrypoint, /await import\('\.\/stack\/app\.js'\)/)
  assert.match(liveEntrypoint, /await import\('\.\/stack\/deploy\.js'\)/)
  assert.match(liveEntrypoint, /async run\(\)/)
  assert.match(liveEntrypoint, /return deployStack\(\)/)
})

test('deploys domain builders in dependency order without ComponentResource parents', () => {
  const deploySource = liveText('scriptEmittingShell', readFileSync(new URL('./deploy.ts', import.meta.url), 'utf8'))
  const calls = [
    'createFoundation(',
    'buildClickHouseStorage(',
    'buildObservability(',
    'buildApi(',
    'buildEdge(',
    'buildRunners(',
  ].map((call) => deploySource.indexOf(call))

  assert.ok(calls.every((index) => index >= 0), 'a stack domain builder is missing')
  assert.deepEqual([...calls].sort((left, right) => left - right), calls)
  assert.doesNotMatch(stackSource, /ComponentResource/)
})

test('does not force a laptop-managed remote builder', () => {
  const appSource = configSection('async app(input)', 'async run()')

  assert.doesNotMatch(appSource, /buildx-builder/)
  assert.doesNotMatch(appSource, /BUILDX_BUILDER/)
  assert.doesNotMatch(environmentExample, /^BUILDX_BUILDER_/m)
})

test('pins the AWS provider used by the deployed stack', () => {
  assert.match(liveConfig, /aws:\s*\{\s*version: '7\.24\.0',\s*region: REGION,/)
})

test('pins every Service load balancer type at the provider boundary', () => {
  const services = [
    {
      name: 'Jaeger',
      type: 'application',
      section: configSection("const jaeger = new sst.aws.Service('Jaeger'", 'const jaegerOtlpHttpEndpoint'),
    },
    {
      name: 'OtelCollector',
      type: 'application',
      section: configSection("const otelCollector = new sst.aws.Service('OtelCollector'", 'const otelCollectorOtlpHttpUrl'),
    },
    {
      name: 'Api',
      type: 'application',
      section: configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role'),
    },
    {
      name: 'Proxy',
      type: 'network',
      section: configSection("new sst.aws.Service('Proxy'", '// ─── 8.'),
    },
    {
      name: 'PgAdmin',
      type: 'application',
      section: configSection("new sst.aws.Service('PgAdmin'", '// MailDev is an unauthenticated mail catcher'),
    },
    {
      name: 'MailDev',
      type: 'application',
      section: configSection("new sst.aws.Service('MailDev'", '// ─── 9.'),
    },
  ]

  for (const service of services) {
    assert.match(
      service.section,
      new RegExp(`loadBalancerType\\s*=\\s*'${service.type}'`),
      `${service.name} must pin its existing ${service.type} load balancer type`,
    )
  }
})

test('applies the deployment permissions boundary to every SST-created IAM role', () => {
  assert.match(liveConfig, /const runtimePermissionsBoundaryArn =/)
  assert.match(liveConfig, /requireIamPermissionsBoundaryStage\(\$app\.stage\)/)
  assert.match(environmentExample, /^IAM_PERMISSIONS_BOUNDARY_STAGE=dev$/m)
  // The sole mechanism applying the boundary to every SST-created role, so it is read live:
  // commented out, the deploy still runs and every role it creates is unbounded.
  assert.match(
    liveConfig,
    /\$transform\(aws\.iam\.Role,[\s\S]*args\.permissionsBoundary \?\?= runtimePermissionsBoundaryArn/,
  )
})

test('keeps every ClickHouse IAM resource inside the deploy-role namespace and provider name limits', () => {
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')

  for (const [resource, nextResource, suffix] of [
    ['ClickHouseRole', 'ClickHouseSsmPolicy', 'instance'],
    ['ClickHouseProfile', 'ClickHouseSecurityGroup', 'instance'],
  ]) {
    const resourceSection = extractSection(clickHouse, `'${resource}'`, `'${nextResource}'`)
    assert.match(
      resourceSection,
      new RegExp(`name:\\s*\`\\$\\{\\$app\\.name\\}-\\$\\{\\$app\\.stage\\}-clickhouse-${suffix}\``),
      `${resource} must use its bounded deterministic ClickHouse name`,
    )
    assert.doesNotMatch(resourceSection, /namePrefix:/, `${resource} must not inherit the provider's 38-character prefix limit`)
  }

  const longestStage = 'x'.repeat(32)
  for (const suffix of ['instance']) {
    const name = `boxlite-${longestStage}-clickhouse-${suffix}`
    assert.ok(name.length <= 64, `${name} exceeds IAM's 64-character role name limit`)
  }
})

test('uses the shared AWS region resolver and waits for the critical API service', () => {
  assert.match(
    liveConfig,
    /await import\('\.\.\/deployment\/environment\.js'\)/,
  )
  assert.match(liveConfig, /const REGION = resolveAwsRegion\(\)/)

  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /wait: true,/)
})

test('waits for the active ClickHouse collector rollout before probing the writer', () => {
  const collector = configSection("const otelCollector = new sst.aws.Service('OtelCollector'", 'const otelCollectorOtlpHttpUrl')
  const writerReadiness = configSection('export function buildClickHouseWriterReady')

  assert.match(collector, /wait: input\.clickHouseResources\.active,/)
  assert.match(writerReadiness, /triggers:\s*\[[\s\S]*otelCollector\.nodes\.taskDefinition\.arn/)
  assert.match(writerReadiness, /dependsOn:\s*\[otelCollector\]/)
  assert.match(writerReadiness, /CLICKHOUSE_READER_SECRET_ARN: resources\.readerSecretArn/)
  assert.doesNotMatch(writerReadiness, /return resources\.ready/)
})

test('injects only ClickHouse passwords through ECS secrets', () => {
  const collector = configSection("const otelCollector = new sst.aws.Service('OtelCollector'", 'const otelCollectorOtlpHttpUrl')
  const api = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')

  assert.match(collector, /CLICKHOUSE_PASSWORD: input\.clickHouseResources\.writerSecretArn/)
  assert.match(api, /CLICKHOUSE_PASSWORD: clickHouseResources\.readerSecretArn/)
  assert.doesNotMatch(collector, /CLICKHOUSE_PASSWORD:\s*envOr/)
  assert.doesNotMatch(api, /CLICKHOUSE_PASSWORD:\s*envOr/)
})

test('rolls each ECS client when its ClickHouse password version changes', () => {
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')
  const collector = configSection("const otelCollector = new sst.aws.Service('OtelCollector'", 'const otelCollectorOtlpHttpUrl')
  const api = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  const writerReadiness = configSection('export function buildClickHouseWriterReady')

  assert.match(liveConfig, /getSecretVersionsOutput\(\{ secretId, region \}\)/)
  assert.match(liveConfig, /versionStages\.includes\('AWSCURRENT'\)/)
  assert.match(clickHouse, /writerSecretVersionId:\s*currentSecretVersionId\(/)
  assert.match(clickHouse, /readerSecretVersionId:\s*currentSecretVersionId\(/)
  assert.match(clickHouse, /writerSecretVersionId:\s*writerSecret\.version\.versionId/)
  assert.match(clickHouse, /readerSecretVersionId:\s*readerSecret\.version\.versionId/)
  assert.match(collector, /CLICKHOUSE_CREDENTIAL_VERSION:\s*input\.clickHouseResources\.writerSecretVersionId/)
  assert.match(api, /CLICKHOUSE_CREDENTIAL_VERSION:\s*clickHouseResources\.readerSecretVersionId/)
  assert.match(writerReadiness, /triggers:\s*\[[^\]]*resources\.readerSecretVersionId/)
})

test('the ClickHouse facade owns its self-hosted secrets', () => {
  const deploy = liveText('scriptEmittingShell', readFileSync(new URL('./deploy.ts', import.meta.url), 'utf8'))
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')

  assert.doesNotMatch(deploy, /ClickHouse(?:Admin|Writer|Reader)Secret/)
  assert.doesNotMatch(deploy, /resolveClickHouseConfig/)
  assert.match(clickHouse, /resolveClickHouseConfig\(process\.env\)/)
  assert.match(clickHouse, /ClickHouseAdminSecret/)
  assert.match(clickHouse, /ClickHouseWriterSecret/)
  assert.match(clickHouse, /ClickHouseReaderSecret/)
})

test('validates managed secret ARNs against the runtime boundary before wiring ECS', () => {
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')

  assert.match(clickHouse, /requireClickHouseSecretArn\(\s*'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN'/)
  assert.match(clickHouse, /requireClickHouseSecretArn\(\s*'CLICKHOUSE_READER_PASSWORD_SECRET_ARN'/)
  assert.match(clickHouse, /region, accountId, appName: \$app\.name, stage: \$app\.stage/)
})

test('orders the API after ClickHouse writer readiness', () => {
  const deploy = configSection('export async function deployStack()')
  const api = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')

  assert.match(deploy, /collectorExporters = clickHouseResources\.active/)
  assert.match(liveConfig, /if \(resources\.mode === 'managed'\) return otelCollector/)
  assert.match(api, /dependsOn: clickHouseReadyDependency \? \[clickHouseReadyDependency\] : \[\]/)
  assert.doesNotMatch(liveConfig, /writerActivation|readerActivation|ClickHouseApiReaderReady/)
})

test('encodes ClickHouse user data before EC2 launch', () => {
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')
  const instance = extractSection(clickHouse, 'const userData =', 'const instance =')

  assert.match(clickHouse, /encodeClickHouseUserData/)
  assert.match(instance, /encodeClickHouseUserData\(\{/)
  assert.doesNotMatch(instance, /Buffer\.from\(buildClickHouseUserData/)
})

test('replaces bootstrap compute while retaining data without blocking a mode switch', () => {
  const clickHouse = configSection('export async function buildClickHouseStorage', 'export function buildClickHouseWriterReady')
  const instance = extractSection(clickHouse, 'const instance = new aws.ec2.Instance(', 'const attachment =')
  const volume = extractSection(clickHouse, "'ClickHouseData',", 'const ami =')

  assert.match(instance, /userDataBase64: userData/)
  assert.match(instance, /userDataReplaceOnChange: true/)
  assert.match(instance, /ignoreChanges: \['ami'\]/)
  assert.doesNotMatch(instance, /ignoreChanges:[^\n]*userDataBase64/)
  assert.match(instance, /deleteBeforeReplace: true/)
  assert.match(volume, /retainOnDelete: true/)
  assert.doesNotMatch(volume, /protect: true/)
})

test('passes an explicitly configured box migration archive prefix to the API', () => {
  assert.match(
    liveConfig,
    /process\.env\.BOX_MIGRATION_ARCHIVE_PREFIX[\s\S]*BOX_MIGRATION_ARCHIVE_PREFIX:\s*process\.env\.BOX_MIGRATION_ARCHIVE_PREFIX/,
  )
})

test('uses the canonical deployment config for every Proxy-facing SST value', () => {
  const runSource = configSection('async run()', '// ── runner bootstrap')

  assert.match(runSource, /resolvePublicDeploymentConfig/)
  assert.match(runSource, /const deploymentConfig = resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(runSource, /const \{ stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion \}/)
  assert.doesNotMatch(runSource, /envOr\('PROXY_(?:DOMAIN|PROTOCOL|TEMPLATE_URL)'/)
})

test('keeps the AWS region in run scope and passes it into Runner user data', () => {
  const runSource = configSection('async run()', '// ── runner bootstrap')
  const runnerUserDataSource = configSection('async function buildRunnerUserData')

  assert.match(runSource, /const REGION = resolveAwsRegion\(\)/)
  assert.equal(runSource.match(/awsRegion: REGION/g)?.length, 1)
  assert.match(runSource, /const runnerUserDataFor[\s\S]*awsRegion: REGION/)
  assert.match(runSource, /runnerUserDataFor\(defaultRunnerApiKey\.result\)/)
  assert.match(runSource, /runnerUserDataFor\(apiKey\.result\)/)
  assert.match(runnerUserDataSource, /awsRegion: string/)
  assert.match(runnerUserDataSource, /Environment=AWS_REGION=\$\{input\.awsRegion\}/)
})

test('tags Runner instances with their exact control-plane identity', () => {
  const runnerResources = configSection('const makeRunner =', '// Register the extra runners')

  assert.match(liveConfig, /await import\('\.\.\/runner\/model\/inventory\.js'\)/)
  assert.match(liveConfig, /const runnerInventory = resolveRunnerInventory\(process\.env\)/)
  assert.match(runnerResources, /'boxlite:control-plane-runner-name': controlPlaneRunnerName/)
  assert.match(
    runnerResources,
    /makeRunner\([\s\S]*defaultRunnerConfig\.resourceName,[\s\S]*defaultRunnerConfig\.nameTag,[\s\S]*defaultRunnerConfig\.controlPlaneRunnerName,[\s\S]*runnerUserData/,
  )
  assert.match(runnerResources, /runnerInventory\.slice\(1\)\.map\([\s\S]*runner\.nameTag,[\s\S]*runnerUserDataFor\(apiKey\.result\)/)
})

test('keeps every Runner instance protected from replacement during full-stack deploys', () => {
  const runnerFactory = configSection('const makeRunner =', '// Default runner')
  const clickHouseInstance = configSection('const instance = new aws.ec2.Instance(', 'const attachment =')

  assert.match(runnerFactory, /new aws\.ec2\.Instance\(/)
  assert.match(runnerFactory, /ignoreChanges: \['ami', 'userDataBase64'\]/)
  assert.match(runnerFactory, /protect: true/)
  assert.equal(liveConfig.match(/new aws\.ec2\.Instance\(/g)?.length, 2)
  assert.doesNotMatch(clickHouseInstance, /protect:/)

  // First boot reads the staged artifact with the instance role, and those two options mean a
  // host that boots before the grant exists never retries. The SSM upgrade path pins the same
  // edge (see the rolling-upgrade test); without this one only half the rule is enforced.
  assert.match(runnerFactory, /dependsOn: \[runnerArtifactPolicy\]/)
})

test('passes both the internal and public OIDC issuers to Proxy', () => {
  const proxyService = configSection("new sst.aws.Service('Proxy'", '// ─── 8.')

  assert.match(proxyService, /OIDC_DOMAIN: oidcIssuer,/)
  assert.match(proxyService, /publicOidcIssuer[\s\S]*OIDC_PUBLIC_DOMAIN: publicOidcIssuer/)
})

test('enables Proxy OTLP logging in hosted and local deployments', () => {
  const proxyService = configSection("new sst.aws.Service('Proxy'", '// ─── 8.')

  assert.match(proxyService, /OTEL_LOGGING_ENABLED: envOr\('OTEL_LOGGING_ENABLED', 'true'\)/)
  assert.match(proxyService, /OTEL_EXPORTER_OTLP_ENDPOINT: envOr\('OTEL_EXPORTER_OTLP_ENDPOINT'/)
  assert.match(
    infraLocalNative,
    /"proxy": _Component\([\s\S]*"OTEL_LOGGING_ENABLED": "true"[\s\S]*"OTEL_EXPORTER_OTLP_ENDPOINT": _OTEL_OTLP_HTTP_URL/,
  )
})

test('routes only the exact public status snapshot path to the configured Backoffice origin', () => {
  const deploy = configSection('export async function deployStack()')
  const edge = configSection('// ─── 9. CDN ROUTES')

  assert.match(deploy, /requireBackofficePublicStatusSnapshotUrl/)
  assert.match(deploy, /const publicStatusOrigin = requireBackofficePublicStatusSnapshotUrl\(\)/)
  assert.match(deploy, /buildEdge\(\{[\s\S]*publicStatusOrigin,/)
  assert.match(edge, /router\.route\('\/public-status\.json\/', api\.url\)/)
  assert.match(edge, /router\.route\('\/public-status\.json', publicStatusOrigin\)/)
  assert.match(edge, /router\.route\('\/', api\.url\)/)
})

test('requires the OIDC client ID through the SST secret store', () => {
  assert.match(liveConfig, /new sst\.Secret\('OIDC_CLIENT_ID'\)/)
  assert.doesNotMatch(liveConfig, /new sst\.Secret\('OIDC_CLIENT_ID',/)
  assert.doesNotMatch(environmentExample, /^OIDC_CLIENT_ID=/m)

  const deploymentGuide = extractSection(readme, '## Deploy an existing stack', '## Secrets & credentials')
  assert.match(deploymentGuide, /npm run bootstrap/)
  assert.match(deploymentGuide, /OIDC_CLIENT_ID/)
  assert.doesNotMatch(deploymentGuide, /App secrets .* are optional/)
  for (const documentation of [readme, environmentExample]) {
    assert.doesNotMatch(documentation, /secret set (?:[A-Z_]+|<NAME>)\s+["']?<[^>\n]+>["']?\s+--stage/)
  }
})

test('the runbook never hands an operator a deploy the wrapper rejects', () => {
  // resolveDeployScope throws before any preflight runs, so a runbook command it refuses is not a
  // documented escape hatch — it is a step that exits 1. Both spellings reach the same guard:
  // package.json points `deploy` and `sst` at one wrapper, which resolves the scope
  // unconditionally, and that gates on `args[0] === 'deploy'`. `npm run sst --` is what this
  // runbook actually uses, so covering only `npm run deploy` would guard the rarer spelling.
  // Targeted `diff` stays legal and must not be flagged.
  //
  // `--target` is still refused for deploys; `--exclude` is refused for anything but the two
  // reviewed component scopes, so the runbook may show those and nothing else.
  assert.doesNotMatch(readme, /npm run (?:deploy|sst -- deploy)[^\n]*--target\b/)
  for (const [, excluded] of readme.matchAll(/npm run (?:deploy|sst -- deploy)[^\n]*--exclude[=\s]+(\S+)/g)) {
    assert.ok(
      ['Api', 'Runner'].includes(excluded),
      `the runbook documents --exclude ${excluded}, which resolveDeployScope refuses`,
    )
  }
  // The prod stage is `prod`, and PRODUCTION_STAGE is why: a runbook naming `production` sends
  // an operator at a stage that does not exist, which is the same drift the guards above pin.
  assert.doesNotMatch(readme, /\bstage[= ]production\b/)
})

test('data-protection guards key off the stage that actually exists: prod', () => {
  // SST state has app/boxlite/prod.json and no production.json — the real
  // stage is `prod`. The deployed prod stack carries retainOnDelete and
  // deletionProtection because it was deployed from a branch that already
  // compared against 'prod'; main still said 'production', so deploying prod
  // from main would have computed isProd === false and reset them. One
  // constant, both call sites, so the two guards cannot drift apart again.
  assert.match(liveConfig, /const PRODUCTION_STAGE = 'prod'/)
  assert.match(liveConfig, /removal: input\?\.stage === PRODUCTION_STAGE \? \('retain' as const\) : \('remove' as const\)/)
  assert.match(liveConfig, /const isProd = \$app\.stage === PRODUCTION_STAGE/)
})

test('no stage-name comparison hardcodes a bare production literal', () => {
  // NODE_ENV / ENVIRONMENT: 'production' are Node runtime values, not stages,
  // and must survive; a stage comparison against the string must not.
  //
  // Match any comparison operator and any quote form. Pinning `stage ===
  // 'production'` alone let the inverse, loose equality, and a template
  // literal through — a guard could compare against the wrong stage name and
  // this test would still pass, which is exactly what it exists to prevent.
  assert.doesNotMatch(liveConfig, /\bstage\b\s*(?:===|!==|==|!=)\s*(?:'production'|"production"|`production`)/)
  assert.doesNotMatch(liveConfig, /(?:'production'|"production"|`production`)\s*(?:===|!==|==|!=)\s*\bstage\b/)
  assert.match(liveConfig, /NODE_ENV: 'production'/)
})

test('the Runner binary upgrade is declared only when the Runner is in scope', () => {
  // `--exclude Runner` keeps the EC2 instance out of the plan, but UpgradeRunnerBinary-* is a
  // sibling of it, not a child, and SST is never passed --exclude-dependents. Its trigger carries
  // the deployed commit, so left declared on an Api-only deploy it fetches runner/<sha>/ for a
  // commit whose build-runner job was skipped. The Runner policy pack cannot catch that:
  // isRunnerLikeResource matches a name against /^Runner(?:-|$)/ OR an aws:ec2/instance:Instance
  // carrying Runner identity tags, and this command satisfies neither arm.
  const live = liveText('scriptEmittingShell', source)
  assert.match(live, /const deploysRunner = readDeployScope\(\)\.includes\('runner'\)/)
  assert.match(live, /import \{ readDeployScope \} from '\.\.\/deployment\/scope\.js'/)
  // The gate must sit on the loop that constructs them, not merely exist somewhere in the file.
  const upgradeIndex = live.indexOf('`UpgradeRunnerBinary-${label}`')
  assert.notEqual(upgradeIndex, -1, 'the Runner upgrade command is missing')
  const loopHeader = live.slice(live.lastIndexOf('let previousUpgrade', upgradeIndex), upgradeIndex)
  assert.match(loopHeader, /!deploysRunner\s*\?\s*\[\]/, 'the upgrade loop is not gated on the deploy scope')
})

test('every local Command pins dir, so it runs from the app root', () => {
  // command.local.Command executes from the Pulumi process's cwd, which is
  // .sst/platform — not the app root. A bare `node scripts/...` therefore
  // resolves to .sst/platform/scripts and fails with "Cannot find module".
  // Only an apply runs these, so a preview cannot catch a missing dir.
  const commands = source.split(/new command\.local\.Command\(/).slice(1)
  assert.ok(commands.length > 0, 'expected at least one command.local.Command in the stack')
  for (const block of commands) {
    const properties = block.slice(0, block.indexOf('triggers:'))
    assert.match(
      properties,
      /dir: \$cli\.paths\.root/,
      'each command.local.Command must set `dir: $cli.paths.root` or its script path resolves under .sst/platform',
    )
  }
})

test('the prod stage keeps deletion protection and a final snapshot', () => {
  assert.match(liveConfig, /args\.deletionProtection = isProd/)
  assert.match(liveConfig, /args\.skipFinalSnapshot = !isProd/)
})

test('every service built from source is accounted for by the release path', () => {
  // Only apps/api has a published-image path, so a release deploy pins that one and still
  // compiles the rest from the deployed checkout. That is a real limitation the release workflow
  // now states; this pins the set so a fourth built service cannot quietly inherit the gap
  // without someone revisiting either the workflow or that statement.
  const built = [...liveConfig.matchAll(/dockerfile: 'apps\/([^/]+)\/Dockerfile'/g)].map(([, app]) => app)
  assert.deepEqual(built.sort(), ['api', 'otel-collector', 'proxy'])

  const releaseWorkflow = readFileSync(
    new URL('../../../.github/workflows/deploy-release.yml', import.meta.url),
    'utf8',
  )
  assert.match(releaseWorkflow, /apps\/proxy and apps\/otel-collector still build/)
})

test('does not restore the removed SSH gateway deployment', () => {
  assert.doesNotMatch(liveConfig, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(environmentExample, /SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(readme, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
})

test('refuses to expose pgAdmin over its plain-HTTP listener', () => {
  const pgAdmin = configSection('// pgAdmin security gate', '// MailDev is an unauthenticated mail catcher')

  assert.match(pgAdmin, /envOr\('PGADMIN_PUBLIC', 'false'\) === 'true'/)
  assert.match(pgAdmin, /PGADMIN_PUBLIC is not supported/)
  assert.match(pgAdmin, /public: false/)
  assert.doesNotMatch(pgAdmin, /public: pgAdminPublic/)
})

test('passes explicit management API endpoints into the API service', () => {
  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')

  assert.match(apiService, /OIDC_MANAGEMENT_API_BASE_URL: process\.env\.OIDC_MANAGEMENT_API_BASE_URL/)
  assert.match(apiService, /OIDC_MANAGEMENT_API_TOKEN_URL: process\.env\.OIDC_MANAGEMENT_API_TOKEN_URL/)
})

test('reports the canonical workspace release unless VERSION overrides it', () => {
  assert.match(liveConfig, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(liveConfig, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(liveConfig, /proxyTemplateUrl, releaseVersion \} = deploymentConfig/)

  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /VERSION: releaseVersion,/)
})

test('the Api deploys either a published image or a build of the deployed checkout', () => {
  // Only one branch runs per deploy, so the other is invisible until someone flips the source.
  // Both are pinned here rather than discovered on the release that first needs them.
  const apiService = configSection('const apiArtifact = resolveArtifactSource', '// Assumed by the Api task role')

  assert.match(liveConfig, /import \{ resolveArtifactSource \} from '\.\.\/artifacts\/source\.js'/)
  assert.match(apiService, /apiArtifact\.kind === 'release'/)
  // Three outcomes, not two: a release tag, a commit tag, and — only when no ref was resolved —
  // the local build context. Losing the `|| apiArtifact.ref` arm would silently put CI back to
  // compiling the Api inside `sst deploy` while its build job still published an image.
  assert.match(apiService, /apiArtifact\.kind === 'release' \|\| apiArtifact\.ref/)
  // The reference is built by the shared helper, which validates the repository name, rather
  // than re-derived here where a bad stage would only surface as an AWS error mid-deploy.
  assert.match(liveConfig, /import \{ apiImageReference \} from '\.\.\/artifacts\/api\.js'/)
  // Pin each argument, not just the call: `[\s\S]*` swallowed them, and artifacts/api.ts does not
  // validate region — a missing one yields `dkr.ecr.undefined.amazonaws.com` at deploy time.
  const imageReference = extractSection(liveConfig, 'apiImageReference({', '})')
  for (const argument of [
    /app: \$app\.name/,
    /stage: \$app\.stage/,
    /accountId/,
    /region: REGION/,
    /version: apiArtifact\.version/,
    // A release names a bare version; passing its ref through would look up a tag that only a
    // commit build ever pushes, and the preflight would refuse a perfectly good release.
    /ref: apiArtifact\.kind === 'release' \? undefined : apiArtifact\.ref/,
  ]) {
    assert.match(imageReference, argument)
  }
  assert.doesNotMatch(apiService, /dkr\.ecr\./)
  assert.match(apiService, /\{ context: '\.\.\/\.\.', dockerfile: 'apps\/api\/Dockerfile' \}/)
  // The repository must predate the stack that consumes it; the stage bootstrap owns it.
  assert.doesNotMatch(apiService, /new aws\.ecr\.Repository/)
  // A cross-reference in a comment, deliberately read from the raw file: the point is that
  // the stack tells a reader where the repository is created, not that anything executes.
  assert.match(source, /bootstrap\/aws\/github-deploy-role\.yaml/)
})

test('the Runner can read only staged build artifacts from the bootstrapped bucket', () => {
  const runner = liveText(
    'scriptEmittingShell',
    readFileSync(new URL('./runners.ts', import.meta.url), 'utf8'),
  )
  const artifactPolicy = extractSection(
    runner,
    "new aws.iam.RolePolicy('RunnerArtifactS3Policy'",
    'const runnerInstanceProfile',
  )

  assert.match(runner, /runnerArtifactsBucketName\(\{ app: \$app\.name, stage: \$app\.stage, accountId \}\)/)
  assert.match(artifactPolicy, /Action: \['s3:GetObject'\]/)
  assert.match(artifactPolicy, /Resource: `arn:aws:s3:::\$\{artifactsBucketName\}\/runner\/\*`/)
  // Both spellings, and `sst.aws.Bucket` is the one that matters: it is what this config
  // actually uses elsewhere (the Storage bucket), so it is how "the stack creates the input it
  // is supposed to consume" would most plausibly come back. The raw-Pulumi form appears nowhere
  // in the file today, so pinning only that would have guarded a spelling nobody writes here.
  assert.doesNotMatch(runner, /new (?:aws\.s3\.Bucket(?:V2)?|sst\.aws\.Bucket)\b/)
  assert.doesNotMatch(artifactPolicy, /s3:(?:PutObject|DeleteObject|ListBucket)/)
})

test('Runner bootstrap fetches the selected artifact and fails closed on its checksum', () => {
  // This function is a TypeScript template emitting bash that runs as root on first boot. Strip
  // both comment styles: the whole verify-then-extract sequence below is otherwise satisfied by
  // a script in which every check has been demoted to a `#` comment.
  const runnerBootstrap = configSection('async function buildRunnerUserData')

  assert.match(runnerBootstrap, /artifactFetchCommand\(/)
  assert.match(runnerBootstrap, /const fetchTarball = artifactFetchCommand/)
  assert.match(runnerBootstrap, /const fetchChecksum = artifactFetchCommand/)
  assert.match(runnerBootstrap, /\$\{fetchTarball\}[\s\S]*\$\{fetchChecksum\}/)
  assert.match(runnerBootstrap, /checksum manifest does not name/)
  assert.ok(runnerBootstrap.includes(`'\\$2 == name || \\$2 == "*" name {print \\$1}'`))
  // The comparison itself, not just its error message: the message survives commenting.
  assert.match(runnerBootstrap, /EXPECTED=\\\$\(awk/)
  assert.match(runnerBootstrap, /ACTUAL=\\\$\(sha256sum/)
  assert.match(runnerBootstrap, /\[ "\\\$EXPECTED" = "\\\$ACTUAL" \]/)
  assert.match(runnerBootstrap, /runner checksum mismatch/)
  assert.ok(
    runnerBootstrap.indexOf('runner checksum mismatch') < runnerBootstrap.indexOf('tar -xzf'),
    'checksum verification must precede extracting the root-owned binary',
  )
})

test('upgrades every Runner through a dependsOn chain, one host per command', () => {
  // The chain is the only thing sequencing the restarts, and it cannot be observed
  // without a real deploy — so it is pinned here, next to the other deploy-shape
  // invariants, rather than left to prose.
  const upgrades = configSection('── Rolling runner binary upgrade')

  // Every Runner gets a command: the default (captured for exactly this) plus each extra.
  assert.match(liveConfig, /const defaultRunner = makeRunner\(/)
  assert.match(upgrades, /\{ label: 'default', instance: defaultRunner \}/)
  assert.match(upgrades, /\.\.\.extraRunners\.map\(\(r\) => \(\{ label: r\.name, instance: r\.instance \}\)\)/)
  assert.match(upgrades, /new command\.local\.Command\(\s*`UpgradeRunnerBinary-\$\{label\}`/)

  // Each command waits on the previous one, so two Runners never restart at once.
  assert.match(upgrades, /previousUpgrade = new command\.local\.Command/)
  // The artifact grant is a prerequisite, not a sibling: build mode reads S3 with the instance
  // role, and Pulumi sees no edge because the bucket reaches the command as a plain string.
  assert.match(
    upgrades,
    /dependsOn: \[instance, runnerArtifactPolicy, \.\.\.\(previousUpgrade \? \[previousUpgrade\] : \[\]\)\]/,
  )
  assert.match(liveConfig, /const runnerArtifactPolicy = new aws\.iam\.RolePolicy\('RunnerArtifactS3Policy'/)

  // Exactly one host per command. A release bump or a build commit change re-runs it.
  assert.match(upgrades, /INSTANCE_IDS: instance\.id/)
  assert.match(upgrades, /const runnerTargetVersion = runnerArtifactSource\.version/)
  assert.match(upgrades, /`build:\$\{runnerArtifactSource\.version\}:\$\{runnerArtifactSource\.ref\}`/)
  assert.match(upgrades, /`release:\$\{runnerArtifactSource\.version\}`/)
  assert.match(upgrades, /RUNNER_VERSION: runnerTargetVersion/)
  assert.match(upgrades, /triggers: \[runnerArtifactTrigger, instance\.id\]/)
  // `triggers` replaces the resource, so `create` must carry the same body as `update`.
  assert.match(
    upgrades,
    /create: 'node scripts\/runner-update-binary\.mjs',\s*update: 'node scripts\/runner-update-binary\.mjs',/,
  )
})

test('no longer points operators at the deleted shell updater', () => {
  assert.doesNotMatch(liveConfig, /scripts\/deploy\/runner-update-binary\.sh/)
  assert.doesNotMatch(readme, /runner-update-binary\.sh/)
  assert.match(readme, /scripts\/runner-update-binary\.mjs/)
})

// BILLING_API_URL used to do more than tell the dashboard where to call: while organization
// creation keyed off it, pointing it anywhere made the API create every non-default organization
// suspended with 'Payment method required' — unclearable by a mock that registers no card. That
// coupling is what must not come back. Suspension is now gated on its own flag, so the guard
// belongs on the condition rather than on the URL.
test('organization suspension is gated on its own flag, not on BILLING_API_URL', () => {
  const organizationService = liveText(
    'scriptEmittingShell',
    readFileSync(new URL('../../api/src/organization/services/organization.service.ts', import.meta.url), 'utf8'),
  )
  // The reason string is only ever produced under the dedicated flag.
  assert.match(organizationService, /configService\.get\('requirePaymentMethod'\)/)
  assert.doesNotMatch(organizationService, /configService\.get\('billingApiUrl'\)/)
  assert.match(
    readFileSync(new URL('../../api/src/config/configuration.ts', import.meta.url), 'utf8'),
    /requirePaymentMethod: process\.env\.REQUIRE_PAYMENT_METHOD === 'true'/,
  )
})

// The dashboard decides whether its billing surfaces exist by whether the Api sent a billing URL,
// so advertising one on a stage that deploys no billing service renders pages whose every request
// 404s. The producing and consuming sides sit in different packages: nothing but a cross-file
// guard notices when one of them moves.
test('a billing URL is advertised only where a billing service answers', () => {
  // Shape, not formatting: the block gained usage-export settings on the same gate, so pinning
  // the one-line spelling would fail on a change that keeps the guarantee exactly. What matters
  // is that the gate is the env var and the value is passed through with no default behind it.
  assert.match(liveConfig, /\.\.\.\(process\.env\.BILLING_API_URL && \{/)
  assert.match(liveConfig, /BILLING_API_URL: process\.env\.BILLING_API_URL,/)
  assert.doesNotMatch(liveConfig, /BILLING_API_URL: envOr\(/)

  // Wallet, plan and usage are sections of one /dashboard/billing page, so the gate moved from
  // the route table into that page: it must refuse to render any section — none of which can
  // load without the billing origin — before it reads one, and return the placeholder instead.
  const billing = liveText(
    'script',
    readFileSync(new URL('../../dashboard/src/pages/Billing.tsx', import.meta.url), 'utf8'),
  )
  const gate = billing.indexOf('if (!config.billingApiUrl)')
  assert.notEqual(gate, -1, 'Billing page must gate on config.billingApiUrl')
  assert.match(billing.slice(gate), /return <BillingComingSoon \/>/)
  // Opening tag, not the whole self-closing element: what has to hold is that the section renders
  // past the gate, and that is just as true once a section takes a prop. Pinning `<X />` made this
  // fail on #1256 giving UsageSection an onGoToWallet prop, which changed nothing about the gate.
  for (const section of ['BillingAlerts', 'PlanSection', 'UsageSection', 'WalletSection']) {
    // `<Name` followed by a delimiter, so the tag is matched whether or not it takes props but a
    // different component sharing the prefix cannot stand in for it.
    const rendered = billing.search(new RegExp(`<${section}[\\s/>]`))
    assert.ok(rendered > gate, `<${section}> must render only past the billing gate`)
  }

  // The per-surface paths that used to be gated are now redirects into that page. A redirect
  // issues no request of its own, so it is safe ungated — but it must not render a page, and
  // must stay out of the force-redirect list that would send it to /boxes instead.
  const app = liveText(
    'script',
    readFileSync(new URL('../../dashboard/src/App.tsx', import.meta.url), 'utf8'),
  )
  const redirectedRoutes = ['BILLING_SPENDING', 'BILLING_WALLET', 'LIMITS', 'PRICING']
  for (const route of redirectedRoutes) {
    // extractSection excludes its end marker, so the closer is matched by the marker itself.
    const routeLine = extractSection(app, `getRouteSubPath(RoutePath.${route})`, '/>')
    assert.match(routeLine, /element=\{<Navigate to=\{RoutePath\.BILLING\} replace $/)
  }
  const hiddenRoutes = extractSection(app, 'const HIDDEN_DASHBOARD_ROUTES = [', ']')
  for (const route of redirectedRoutes) {
    assert.doesNotMatch(hiddenRoutes, new RegExp(route))
  }
})

// Where usage is shipped and where the dashboard calls are one letter apart in intent and a whole
// route apart in fact: the publisher appends /internal/usage-events, which the billing service
// serves off its bare origin because that route authenticates a service rather than a user, so it
// sits outside the /api/billing prefix (boxlite-commerce src/http.ts). Handing the exporter
// BILLING_API_URL's value is the plausible edit that 404s every batch, silently, for as long as
// nobody reads the outbox — and the two sides sit in different repositories, where no type checks
// the seam. Deriving the origin is what makes the two impossible to point apart by accident.
test('usage is exported to the ingest origin, never to the dashboard billing URL', () => {
  assert.match(
    liveConfig,
    /USAGE_EXPORT_URL: envOr\('USAGE_EXPORT_URL', new URL\(process\.env\.BILLING_API_URL\)\.origin\)/,
  )
  assert.doesNotMatch(liveConfig, /USAGE_EXPORT_URL: envOr\([^)]*\/api\/billing/)

  // Delivery is gated on the credential, not asserted alongside it: configuration.ts throws when
  // export is enabled without a token, so a stage pointed at a billing service but holding no
  // secret must come up exporting nothing rather than crash-loop on boot.
  assert.match(liveConfig, /USAGE_EXPORT_TOKEN: usageExportToken\.value/)
  assert.match(
    liveConfig,
    /USAGE_EXPORT_ENABLED: usageExportToken\.value\.apply\(\(token(?:: string)?\) => \(token\.trim\(\) \? 'true' : 'false'\)\)/,
  )
  assert.match(
    liveConfig,
    /USAGE_ALLOCATION_SNAPSHOT_ENABLED: usageExportToken\.value\.apply\(\(token(?:: string)?\) =>\s*\(token\.trim\(\) \? 'true' : 'false'\),?\s*\)/,
  )
  assert.match(liveConfig, /const usageExportToken = new sst\.Secret\('USAGE_EXPORT_TOKEN', ''\)/)

  // Nothing here can discover the receiving half — it belongs to the billing service's own stack —
  // so the note naming the value to set is the only thing between an operator and a stage that
  // 401s every batch, and it must keep naming it.
  assert.match(environmentExample, /^# USAGE_EXPORT_URL=/m)
  assert.match(environmentExample, /boxlite-commerce\/<stage>\/usage-ingest-token/)
  assert.doesNotMatch(environmentExample, /^USAGE_EXPORT_TOKEN=/m)
})
