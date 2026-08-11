// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { liveText } from './live-source.mjs'

const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SST_CONFIG_SOURCE = readFileSync(new URL('../sst.config.ts', import.meta.url), 'utf8')
const LIVE_SST_CONFIG = liveText('scriptEmittingShell', SST_CONFIG_SOURCE)
const RUNTIME_SECRETS_CLI_SOURCE = liveText(
  'script',
  readFileSync(new URL('./runtime-secrets-cli.mjs', import.meta.url), 'utf8'),
)

const EXPECTED_RUNTIME_SECRET_DEFINITIONS = [
  {
    id: 'encryptionKey',
    environmentKeys: ['ENCRYPTION_KEY'],
    consumers: [{ component: 'Api', environmentKey: 'ENCRYPTION_KEY' }],
  },
  {
    id: 'encryptionSalt',
    environmentKeys: ['ENCRYPTION_SALT'],
    consumers: [{ component: 'Api', environmentKey: 'ENCRYPTION_SALT' }],
  },
  {
    id: 'adminApiKey',
    environmentKeys: ['ADMIN_API_KEY'],
    consumers: [
      { component: 'Api', environmentKey: 'ADMIN_API_KEY' },
      { component: 'RegisterExtraRunners', environmentKey: 'ADMIN_API_KEY' },
    ],
  },
  {
    id: 'proxyApiKey',
    environmentKeys: ['PROXY_API_KEY'],
    consumers: [
      { component: 'Api', environmentKey: 'PROXY_API_KEY' },
      { component: 'Proxy', environmentKey: 'PROXY_API_KEY' },
    ],
  },
  {
    id: 'defaultRunnerApiKey',
    environmentKeys: ['DEFAULT_RUNNER_API_KEY'],
    consumers: [
      { component: 'Api', environmentKey: 'DEFAULT_RUNNER_API_KEY' },
      { component: 'DefaultRunner', environmentKey: 'BOXLITE_RUNNER_TOKEN' },
    ],
  },
  {
    id: 'pgAdminDefaultPassword',
    environmentKeys: ['PGADMIN_DEFAULT_PASSWORD'],
    consumers: [{ component: 'PgAdmin', environmentKey: 'PGADMIN_DEFAULT_PASSWORD' }],
  },
  {
    id: 'ghcrPullToken',
    environmentKeys: ['GHCR_TOKEN'],
    consumers: [
      { component: 'DefaultRunner', environmentKey: 'GHCR_TOKEN' },
      { component: 'ExtraRunner', environmentKey: 'GHCR_TOKEN' },
    ],
  },
  {
    id: 'clickHouseWriterPassword',
    environmentKeys: ['CLICKHOUSE_WRITER_PASSWORD', 'CLICKHOUSE_PASSWORD'],
    consumers: [{ component: 'OtelCollector', environmentKey: 'CLICKHOUSE_PASSWORD' }],
  },
  {
    id: 'clickHouseReaderPassword',
    environmentKeys: ['CLICKHOUSE_READER_PASSWORD', 'CLICKHOUSE_PASSWORD'],
    consumers: [{ component: 'Api', environmentKey: 'CLICKHOUSE_PASSWORD' }],
  },
  {
    id: 'otelExporterOtlpHeaders',
    environmentKeys: ['OTEL_EXPORTER_OTLP_HEADERS'],
    consumers: [
      { component: 'Api', environmentKey: 'OTEL_EXPORTER_OTLP_HEADERS' },
      { component: 'Proxy', environmentKey: 'OTEL_EXPORTER_OTLP_HEADERS' },
    ],
  },
  {
    id: 'otelCollectorApiKey',
    environmentKeys: ['BOXLITE_API_KEY', 'OTEL_COLLECTOR_API_KEY', 'ADMIN_API_KEY'],
    consumers: [
      { component: 'OtelCollector', environmentKey: 'BOXLITE_API_KEY' },
      { component: 'Api', environmentKey: 'OTEL_COLLECTOR_API_KEY' },
    ],
  },
]

const EXPECTED_SECRET_NAMES = {
  encryptionKey: 'boxlite-dev-runtime/encryption-key',
  encryptionSalt: 'boxlite-dev-runtime/encryption-salt',
  adminApiKey: 'boxlite-dev-runtime/admin-api-key',
  proxyApiKey: 'boxlite-dev-runtime/proxy-api-key',
  defaultRunnerApiKey: 'boxlite-dev-runtime/default-runner-api-key',
  pgAdminDefaultPassword: 'boxlite-dev-runtime/pg-admin-default-password',
  ghcrPullToken: 'boxlite-dev-runtime/ghcr-pull-token',
  clickHouseWriterPassword: 'boxlite-dev-runtime/click-house-writer-password',
  clickHouseReaderPassword: 'boxlite-dev-runtime/click-house-reader-password',
  otelExporterOtlpHeaders: 'boxlite-dev-runtime/otel-exporter-otlp-headers',
  otelCollectorApiKey: 'boxlite-dev-runtime/otel-collector-api-key',
}

const EXPECTED_STALE_SST_SECRET_NAMES = [
  'SSH_PRIVATE_KEY_B64',
  'SSH_HOST_KEY_B64',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_PREVIOUS',
]

const EXPECTED_SST_APP_SECRET_NAMES = [
  'OIDC_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_SECRET',
  'POSTHOG_API_KEY',
  'SVIX_AUTH_TOKEN',
  'USAGE_EXPORT_TOKEN',
]

const SERVICE_MARKERS = {
  OtelCollector: [
    "const otelCollector = new sst.aws.Service('OtelCollector'",
    'const otelCollectorOtlpHttpUrl',
  ],
  Api: ["const api = new sst.aws.Service('Api'", '// ─── 7. EDGE SERVICES'],
  Proxy: ["new sst.aws.Service('Proxy'", '// ─── 8. ADMIN UIs'],
  PgAdmin: ["new sst.aws.Service('PgAdmin'", "new sst.aws.Service('MailDev'"],
}

const SERVICE_COMPONENTS = new Set(Object.keys(SERVICE_MARKERS))

async function runtimeSecretsModule() {
  return import('./runtime-secrets.mjs')
}

function extractSection(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = contents.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  assert.ok(end > start, `end marker must follow start marker: ${endMarker}`)
  return contents.slice(start, end)
}

function findClosingBrace(contents, openingBrace) {
  let depth = 0
  let quote
  let escaped = false

  for (let index = openingBrace; index < contents.length; index += 1) {
    const character = contents[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  assert.fail('object literal has no closing brace')
}

function extractObjectProperty(contents, propertyName) {
  const property = new RegExp(`\\b${propertyName}\\s*:\\s*\\{`).exec(contents)
  assert.ok(property, `missing ${propertyName} object`)
  const openingBrace = contents.indexOf('{', property.index)
  return contents.slice(openingBrace + 1, findClosingBrace(contents, openingBrace))
}

function serviceSource(component) {
  const [startMarker, endMarker] = SERVICE_MARKERS[component]
  return liveText('scriptEmittingShell', extractSection(SST_CONFIG_SOURCE, startMarker, endMarker))
}

function directEnvironmentKeys(objectSource) {
  return [...objectSource.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map(([, key]) => key)
}

function minimalEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...overrides,
  }
}

function runInfraScript(args, environment = {}, input, { cwd = INFRA_ROOT } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: minimalEnvironment(environment),
    encoding: 'utf8',
    input,
    timeout: 10_000,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}

async function withIsolatedSstDiagnosticLog(callback) {
  const isolatedInfraRoot = await mkdtemp(join(tmpdir(), 'boxlite-isolated-infra-log-'))
  await cp(join(INFRA_ROOT, 'scripts'), join(isolatedInfraRoot, 'scripts'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.mjs'),
  })
  const diagnosticLog = join(isolatedInfraRoot, '.sst', 'log', 'sst.log')
  await mkdir(dirname(diagnosticLog), { recursive: true })
  try {
    return await callback(diagnosticLog, isolatedInfraRoot)
  } finally {
    await rm(isolatedInfraRoot, { recursive: true, force: true })
  }
}

test('publishes the exact runtime-secret registry, legacy source precedence, and consumers', async () => {
  const { RUNTIME_SECRET_DEFINITIONS, runtimeSecretName } = await runtimeSecretsModule()
  const projection = RUNTIME_SECRET_DEFINITIONS.map(({ id, environmentKeys, consumers }) => ({
    id,
    environmentKeys,
    consumers,
  }))

  assert.deepEqual(projection, EXPECTED_RUNTIME_SECRET_DEFINITIONS)
  assert.deepEqual(
    Object.fromEntries(projection.map(({ id }) => [id, runtimeSecretName('dev', id)])),
    EXPECTED_SECRET_NAMES,
  )
  for (const stage of ['../prod', 'Dev', 'dev_test', 'dev-blue', 'a'.repeat(21)]) {
    assert.throws(() => runtimeSecretName(stage, 'adminApiKey'), /stage/i)
  }
  assert.throws(() => runtimeSecretName('dev', 'notARegisteredSecret'), /secret|id/i)
})

test('validates the exact nonsecret AWSCURRENT generation map and consumer markers', async () => {
  const {
    PENDING_RUNTIME_SECRET_GENERATION,
    parseRuntimeSecretGenerations,
    runtimeSecretGeneration,
    runtimeSecretGenerationMarker,
  } = await runtimeSecretsModule()
  const generations = Object.fromEntries(
    EXPECTED_RUNTIME_SECRET_DEFINITIONS.map(({ id }, index) => [
      id,
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ]),
  )
  generations.ghcrPullToken = PENDING_RUNTIME_SECRET_GENERATION

  const parsed = parseRuntimeSecretGenerations(JSON.stringify(generations))
  assert.deepEqual(parsed, generations)
  assert.equal(runtimeSecretGeneration(parsed, 'ghcrPullToken'), PENDING_RUNTIME_SECRET_GENERATION)
  assert.equal(
    runtimeSecretGenerationMarker(parsed, ['proxyApiKey', 'otelExporterOtlpHeaders']),
    JSON.stringify({
      otelExporterOtlpHeaders: generations.otelExporterOtlpHeaders,
      proxyApiKey: generations.proxyApiKey,
    }),
  )

  const markerFor = (component, generationMap) =>
    runtimeSecretGenerationMarker(
      generationMap,
      EXPECTED_RUNTIME_SECRET_DEFINITIONS.filter(({ consumers }) =>
        consumers.some((consumer) => consumer.component === component),
      ).map(({ id }) => id),
    )
  const rotatedAdmin = {
    ...parsed,
    adminApiKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  }
  assert.notEqual(markerFor('Api', parsed), markerFor('Api', rotatedAdmin))
  for (const component of ['Proxy', 'PgAdmin', 'OtelCollector']) {
    assert.equal(
      markerFor(component, parsed),
      markerFor(component, rotatedAdmin),
      `${component} must not restart for an admin-only rotation`,
    )
  }

  const { ghcrPullToken: _missing, ...missingGeneration } = generations
  assert.throws(() => parseRuntimeSecretGenerations(JSON.stringify(missingGeneration)), /generation|ghcrPullToken/i)
  assert.throws(
    () => parseRuntimeSecretGenerations(JSON.stringify({ ...generations, unregistered: 'a'.repeat(32) })),
    /generation|unregistered/i,
  )
  const invalidSentinel = 'synthetic-generation-value-that-must-not-be-echoed!'
  assert.throws(
    () => parseRuntimeSecretGenerations(JSON.stringify({ ...generations, adminApiKey: invalidSentinel })),
    (error) => /generation|adminApiKey/i.test(error.message) && !error.message.includes(invalidSentinel),
  )
  assert.throws(() => runtimeSecretGeneration(parsed, 'unregistered'), /generation|secret|id/i)
  assert.throws(
    () => runtimeSecretGenerationMarker(parsed, ['proxyApiKey', 'proxyApiKey']),
    /duplicate|generation|secret/i,
  )
})

test('keeps the stale SST deletion allowlist exact', async () => {
  const { SST_APP_SECRET_NAMES, STALE_SST_SECRET_NAMES, sstSecretStatusParameterName } =
    await runtimeSecretsModule()

  assert.deepEqual(SST_APP_SECRET_NAMES, EXPECTED_SST_APP_SECRET_NAMES)
  assert.deepEqual(
    SST_APP_SECRET_NAMES,
    [...SST_CONFIG_SOURCE.matchAll(/new sst\.Secret\('([^']+)'/g)].map(([, name]) => name),
    'every live SST app secret must have safe status metadata',
  )
  assert.deepEqual(STALE_SST_SECRET_NAMES, EXPECTED_STALE_SST_SECRET_NAMES)
  for (const name of [...SST_APP_SECRET_NAMES, ...STALE_SST_SECRET_NAMES]) {
    assert.equal(sstSecretStatusParameterName('dev', name), `/boxlite/dev/sst-secret-status/${name}`)
  }
  for (const stage of ['../prod', 'Dev', 'dev_test', 'dev-blue', 'a'.repeat(21)]) {
    assert.throws(() => sstSecretStatusParameterName(stage, 'OIDC_CLIENT_ID'), /stage/i)
  }
  assert.throws(() => sstSecretStatusParameterName('dev', 'UNREGISTERED_SECRET'), /registered|secret/i)
})

test('selects the exact first explicit seed and rejects unsafe configured values', async () => {
  const { resolveRuntimeSecretSeedValues } = await runtimeSecretsModule()
  const environment = {
    BOXLITE_API_KEY: 'exact-boxlite-key ',
    OTEL_COLLECTOR_API_KEY: 'lower-precedence-key',
    ADMIN_API_KEY: 'admin-fallback',
    GHCR_TOKEN: '',
  }

  const seeds = resolveRuntimeSecretSeedValues(environment)
  assert.deepEqual(
    seeds.find(({ id }) => id === 'otelCollectorApiKey'),
    { id: 'otelCollectorApiKey', sourceKey: 'BOXLITE_API_KEY', value: 'exact-boxlite-key ' },
  )
  assert.equal(seeds.some(({ id }) => id === 'ghcrPullToken'), false)
  assert.throws(() => resolveRuntimeSecretSeedValues({ GHCR_TOKEN: '   ' }), /GHCR_TOKEN.*whitespace/)
  assert.throws(() => resolveRuntimeSecretSeedValues({ DEFAULT_RUNNER_API_KEY: 'line-one\nline-two' }), /single-line/)
  assert.throws(() => resolveRuntimeSecretSeedValues({ ENCRYPTION_KEY: 'bad\0value' }), /NUL/)
  assert.throws(() => resolveRuntimeSecretSeedValues({ GHCR_TOKEN: 'unused' }), /reserved placeholder/)
  assert.throws(() => resolveRuntimeSecretSeedValues({ CLICKHOUSE_PASSWORD: 'None' }), /reserved placeholder/)
})

test('preserves explicit bootstrap values and gates generated consumers on their initial version', async () => {
  const { runtimeSecretNeedsGeneratedInitialVersion } = await runtimeSecretsModule()

  assert.equal(
    runtimeSecretNeedsGeneratedInitialVersion({
      'boxlite:initial-value': 'generated',
      'boxlite:initialization': 'pending',
    }),
    true,
  )
  for (const initialValue of ['generated', 'explicit']) {
    assert.equal(
      runtimeSecretNeedsGeneratedInitialVersion({
        'boxlite:initial-value': initialValue,
        'boxlite:initialization': 'sealed',
      }),
      false,
    )
  }
  assert.throws(
    () =>
      runtimeSecretNeedsGeneratedInitialVersion({
        'boxlite:initial-value': 'updating',
        'boxlite:initialization': 'pending',
      }),
    /generated\|explicit/,
  )
  assert.throws(() => runtimeSecretNeedsGeneratedInitialVersion({}), /generated\|explicit/)
  assert.match(LIVE_SST_CONFIG, /ignoreChanges:\s*\['secretString'\]/)
  assert.match(
    LIVE_SST_CONFIG,
    /runtimeSecretArn[\s\S]*\$resolve\(\[secret\.arn, initialVersion\.versionId\]\)/,
  )
  assert.doesNotMatch(SST_CONFIG_SOURCE, /DEPLOY_ENV/)
})

test('fails synthesis when an enabled integration still has a generated placeholder', () => {
  assert.match(
    LIVE_SST_CONFIG,
    /if \(clickHouseExporterEnabled\)[\s\S]*requireExplicitRuntimeSecret\('clickHouseWriterPassword'/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /if \(clickHouseReaderUrl \|\| clickHouseReaderHost\)[\s\S]*requireExplicitRuntimeSecret\([\s\S]*'clickHouseReaderPassword'/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /if \(ghcrUsername\)[\s\S]*requireExplicitRuntimeSecret\('ghcrPullToken'/,
  )
})

test('wires every ECS runtime credential through Service.ssm by Secrets Manager ARN only', async () => {
  const { RUNTIME_SECRET_DEFINITIONS } = await runtimeSecretsModule()
  const expectedByService = Object.fromEntries([...SERVICE_COMPONENTS].map((component) => [component, []]))
  for (const definition of RUNTIME_SECRET_DEFINITIONS) {
    for (const consumer of definition.consumers) {
      if (!SERVICE_COMPONENTS.has(consumer.component)) continue
      expectedByService[consumer.component].push({
        id: definition.id,
        environmentKey: consumer.environmentKey,
      })
    }
  }

  assert.match(LIVE_SST_CONFIG, /const runtimeSecrets\s*=/)
  assert.match(LIVE_SST_CONFIG, /const runtimeSecretArn\s*=/)

  for (const [component, expectedConsumers] of Object.entries(expectedByService)) {
    const source = serviceSource(component)
    const ssm = extractObjectProperty(source, 'ssm')
    const environment = extractObjectProperty(source, 'environment')

    assert.deepEqual(
      directEnvironmentKeys(ssm).sort(),
      expectedConsumers.map(({ environmentKey }) => environmentKey).sort(),
      `${component}.ssm must contain exactly its registered runtime-secret consumers`,
    )
    for (const { id, environmentKey } of expectedConsumers) {
      assert.match(
        ssm,
        new RegExp(`^\\s*${environmentKey}\\s*:\\s*runtimeSecretArn\\('${id}'\\)\\s*,?`, 'm'),
        `${component}.${environmentKey} must resolve the stable Secrets Manager ARN`,
      )
      assert.doesNotMatch(
        environment,
        new RegExp(`^\\s*${environmentKey}\\s*:`, 'm'),
        `${component}.${environmentKey} must not also carry a plaintext task environment value`,
      )
    }
  }
})

test('restarts each ECS consumer only for the runtime secrets it consumes', () => {
  assert.match(
    LIVE_SST_CONFIG,
    /const runtimeSecretGenerations = parseRuntimeSecretGenerations\(\s*process\.env\.BOXLITE_RUNTIME_SECRET_GENERATIONS,?\s*\)/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /const runtimeSecretGenerationMarkerFor = \(component: string\)[\s\S]*RUNTIME_SECRET_DEFINITIONS\.filter\([\s\S]*consumer\.component === component[\s\S]*runtimeSecretGenerationMarker/,
  )

  for (const component of SERVICE_COMPONENTS) {
    const environment = extractObjectProperty(serviceSource(component), 'environment')
    assert.match(
      environment,
      new RegExp(
        `^\\s*BOXLITE_RUNTIME_SECRET_GENERATION\\s*:\\s*runtimeSecretGenerationMarkerFor\\('${component}'\\)`,
        'm',
      ),
      `${component} must carry only its registry-derived runtime-secret generation marker`,
    )
  }

  const registerRunners = liveText(
    'scriptEmittingShell',
    extractSection(SST_CONFIG_SOURCE, "'RegisterExtraRunners'", '// ── Rolling runner binary upgrade'),
  )
  assert.match(
    registerRunners,
    /triggers:\s*\[\s*api\.url,\s*runnersPayload,\s*runtimeSecretGeneration\(runtimeSecretGenerations,\s*'adminApiKey'\),?\s*\]/,
  )
})

test('passes only secret ARNs to deployment-time and default-runner consumers', () => {
  const defaultRunner = liveText(
    'scriptEmittingShell',
    extractSection(SST_CONFIG_SOURCE, 'const runnerUserData =', '// Runners hold load-bearing box state'),
  )
  const registerRunners = liveText(
    'scriptEmittingShell',
    extractSection(SST_CONFIG_SOURCE, "'RegisterExtraRunners'", '// ── Rolling runner binary upgrade'),
  )
  const runnerUserDataBuilder = liveText(
    'scriptEmittingShell',
    extractSection(SST_CONFIG_SOURCE, 'async function buildRunnerUserData', 'return Buffer.from(script)'),
  )

  assert.match(defaultRunner, /runtimeSecretArn\('defaultRunnerApiKey'\)/)
  assert.match(defaultRunner, /runtimeSecretArn\('ghcrPullToken'\)/)
  assert.match(
    defaultRunner,
    /\$resolve\(\[\s*api\.url,\s*otelCollectorOtlpHttpUrl,\s*runtimeSecretArn\('defaultRunnerApiKey'\),\s*runtimeSecretArn\('ghcrPullToken'\),?\s*\]\)\.apply\(\(\[apiUrl, otelEndpoint, tokenSecretArn, ghcrSecretArn\]\)/,
  )
  assert.doesNotMatch(defaultRunner, /defaultRunnerApiKey\.(?:result|value)/)
  assert.doesNotMatch(defaultRunner, /ghcrToken/)

  assert.match(registerRunners, /ADMIN_API_KEY_SECRET_ARN:\s*runtimeSecretArn\('adminApiKey'\)/)
  assert.doesNotMatch(registerRunners, /^\s*ADMIN_API_KEY\s*:/m)

  assert.match(runnerUserDataBuilder, /secretsmanager get-secret-value/)
  assert.match(runnerUserDataBuilder, /BOXLITE_RUNNER_TOKEN_SECRET_ARN/)
  assert.match(runnerUserDataBuilder, /export BOXLITE_RUNNER_TOKEN/)
  assert.equal(
    (runnerUserDataBuilder.match(/2>\/dev\/null \|\| true/g) ?? []).length,
    2,
    'both generated start-wrapper fetches must tolerate a transient AWS failure under set -e',
  )
  assert.doesNotMatch(defaultRunner, /\btoken\s*:/)
})

test('keeps the historical Runner role on default and isolates extras behind a stage-bound role', () => {
  const legacyGhcr = extractSection(
    LIVE_SST_CONFIG,
    "const legacyGhcrSecret = new aws.secretsmanager.Secret(",
    "const extraRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('ExtraRunnerRuntimeSecretPolicy'",
  )
  const extraRolePolicy = extractSection(
    LIVE_SST_CONFIG,
    "const extraRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('ExtraRunnerRuntimeSecretPolicy'",
    "const defaultRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('DefaultRunnerRuntimeSecretPolicy'",
  )
  const defaultRolePolicy = extractSection(
    LIVE_SST_CONFIG,
    "const defaultRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('DefaultRunnerRuntimeSecretPolicy'",
    'const runnerUserData =',
  )
  const defaultRunner = extractSection(
    LIVE_SST_CONFIG,
    'const defaultRunner = makeRunner(',
    'const defaultRunnerLegacyRollbackGuard',
  )
  const extraRunners = extractSection(LIVE_SST_CONFIG, 'const extraRunners =', 'if (extraRunners.length > 0)')

  assert.match(legacyGhcr, /'GhcrPullToken'[\s\S]*retainOnDelete:\s*true/)
  assert.match(legacyGhcr, /'GhcrPullTokenValue'[\s\S]*ignoreChanges:\s*\['secretString'\][\s\S]*retainOnDelete:\s*true/)
  assert.match(LIVE_SST_CONFIG, /new aws\.iam\.InstanceProfile\('RunnerProfile',\s*\{ role: runnerRole\.name \}\)/)
  assert.match(LIVE_SST_CONFIG, /new aws\.iam\.Role\('ExtraRunnerRole'/)
  assert.match(LIVE_SST_CONFIG, /new aws\.iam\.InstanceProfile\('ExtraRunnerProfile'/)
  assert.match(LIVE_SST_CONFIG, /name:\s*extraRunnerInstanceProfileName\(\$app\.stage\)/)
  assert.doesNotMatch(LIVE_SST_CONFIG, /new aws\.iam\.(?:Role|InstanceProfile)\('DefaultRunner(?:Role|Profile)'/)
  assert.match(defaultRunner, /instanceProfile:\s*runnerInstanceProfile\.name/)
  assert.match(
    defaultRunner,
    /policies:\s*\[\s*runnerSsmPolicy,\s*runnerVolumeS3Policy,\s*runnerArtifactPolicy,\s*defaultRunnerRuntimeSecretPolicy,?\s*\],?/,
  )
  assert.match(extraRunners, /instanceProfile:\s*extraRunnerInstanceProfile\.name/)
  assert.match(
    extraRunners,
    /policies:\s*\[\s*extraRunnerSsmPolicy,\s*extraRunnerVolumeS3Policy,\s*extraRunnerArtifactPolicy,\s*extraRunnerRuntimeSecretPolicy,?\s*\],?/,
  )
  assert.match(extraRolePolicy, /role:\s*extraRunnerRole\.name/)
  assert.match(
    extraRolePolicy,
    /\$resolve\(\[legacyGhcrSecret\.arn,\s*runtimeSecretArn\('ghcrPullToken'\)\]\)\.apply\(\s*\(\[legacyGhcrTokenArn,\s*ghcrTokenArn\]\)/,
  )
  assert.match(extraRolePolicy, /Resource:\s*\[legacyGhcrTokenArn,\s*ghcrTokenArn\]/)
  assert.doesNotMatch(extraRolePolicy, /defaultRunnerApiKey|runnerTokenArn/)
  for (const { id } of EXPECTED_RUNTIME_SECRET_DEFINITIONS) {
    if (id === 'ghcrPullToken') continue
    assert.doesNotMatch(extraRolePolicy, new RegExp(`runtimeSecretArn\\('${id}'\\)`))
  }
  assert.doesNotMatch(extraRolePolicy, /Resource:\s*['"]\*['"]|secretsmanager:\*/)
  assert.match(defaultRolePolicy, /role:\s*runnerRole\.name/)
  assert.match(
    defaultRolePolicy,
    /\$resolve\(\[\s*legacyGhcrSecret\.arn,\s*runtimeSecretArn\('defaultRunnerApiKey'\),\s*runtimeSecretArn\('ghcrPullToken'\),?\s*\]\)/,
  )
  assert.match(defaultRolePolicy, /Resource:\s*\[legacyGhcrTokenArn,\s*ghcrTokenArn\]/)
  assert.match(
    defaultRolePolicy,
    /Resource:\s*runnerTokenArn,[\s\S]*Condition:\s*\{[\s\S]*ArnEquals:\s*\{[\s\S]*'ec2:SourceInstanceARN':\s*defaultRunnerSourceArn/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /const runnerStateBaseline = parseRunnerStateBaseline\(process\.env\.BOXLITE_RUNNER_STATE_BASELINE\)[\s\S]*const defaultRunnerSourceArn = `arn:aws:ec2:\$\{REGION\}:\$\{accountId\}:instance\/\$\{defaultRunnerInstanceId\}`/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /if \(!defaultRunnerInstanceId\)\s*\{\s*throw new Error\('Runner state baseline must include the protected default Runner'\)/,
  )
  assert.doesNotMatch(defaultRolePolicy, /Resource:\s*['"]\*['"]|secretsmanager:\*/)
})

test('reconciles only the extra runner GHCR ARN and rolls every touched file back on failure', async () => {
  const { buildExtraRunnerGhcrMigration } = await import('./runtime-secrets-cli.mjs')
  const legacyGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-GhcrPullToken-AbCdEf'
  const ghcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const tokenSentinel = 'synthetic-existing-extra-runner-token-that-must-be-preserved'
  const migration = buildExtraRunnerGhcrMigration({
    region: 'ap-southeast-1',
    legacyGhcrSecretArn,
    ghcrSecretArn,
    ghcrEnabled: true,
    ghcrUsername: 'boxlite-ai',
  })
  const shellSyntax = spawnSync('bash', ['-n'], { input: migration, encoding: 'utf8' })

  assert.equal(shellSyntax.status, 0, shellSyntax.stderr)
  assert.equal(migration.includes('\0'), false, 'the SSM shell payload must not contain a literal NUL byte')
  assert.doesNotMatch(migration, new RegExp(tokenSentinel))
  assert.doesNotMatch(migration, /BOXLITE_RUNNER_TOKEN_SECRET_ARN/)
  assert.doesNotMatch(migration, /sed -i ['"]\/\^Environment=BOXLITE_RUNNER_TOKEN=/)
  assert.match(migration, /TOKEN_LINE_DIGEST_BEFORE[\s\S]*TOKEN_LINE_DIGEST_AFTER/)
  assert.match(migration, /LEGACY_GHCR_SECRET_ARN/)
  assert.match(migration, /GHCR_SECRET_ARN/)
  assert.equal((migration.match(/export GHCR_TOKEN/g) ?? []).length, 1)
  assert.match(migration, /trap rollback EXIT/)
  assert.match(migration, /get-secret-value[\s\S]*2>\/dev\/null \|\| true/)
  assert.match(migration, /\/var\/lib\/cloud\/instances\/\*\/user-data\.txt/)
  assert.match(migration, /\/var\/lib\/cloud\/instances\/\*\/scripts\/part-001/)

  for (const failAfterRestart of [false, true]) {
    const fixture = await mkdtemp(join(tmpdir(), 'boxlite-extra-runner-ghcr-migration-'))
    const fakeBin = join(fixture, 'bin')
    const unit = join(fixture, 'boxlite-runner.service')
    const wrapper = join(fixture, 'boxlite-runner-start.sh')
    const dropInDir = join(fixture, 'boxlite-runner.service.d')
    const dropIn = join(dropInDir, 'ghcr-runtime-secret.conf')
    const cloudUserData = join(fixture, 'cloud-user-data.txt')
    const cloudScript = join(fixture, 'cloud-part-001')
    const tokenLine = `Environment=BOXLITE_RUNNER_TOKEN=${tokenSentinel}`
    const legacyLine = `Environment=GHCR_SECRET_ARN=${legacyGhcrSecretArn}`
    const legacyUsernameLine = 'Environment=GHCR_USERNAME=legacy-owner'
    const originalUnit = `[Service]\n${tokenLine}\n${legacyUsernameLine}\n${legacyLine}\nExecStart=${wrapper}\n`
    const originalCache = `#!/bin/bash\n${tokenLine}\n${legacyUsernameLine}\n${legacyLine}\n`
    const originalWrapper =
      '#!/bin/bash\nGHCR_TOKEN=$(aws secretsmanager get-secret-value --secret-id "$GHCR_SECRET_ARN")\n'

    try {
      await mkdir(fakeBin, { recursive: true })
      await Promise.all([
        writeFile(unit, originalUnit, { mode: 0o640 }),
        writeFile(wrapper, originalWrapper, { mode: 0o755 }),
        writeFile(cloudUserData, originalCache, { mode: 0o600 }),
        writeFile(cloudScript, originalCache, { mode: 0o600 }),
        writeFile(
          join(fakeBin, 'aws'),
          '#!/bin/sh\nprintf %s synthetic-stable-ghcr-value\n',
          { mode: 0o755 },
        ),
        writeFile(
          join(fakeBin, 'systemctl'),
          '#!/bin/sh\nif [ "$1" = is-active ] && [ "$SYNTHETIC_FAIL_ACTIVE" = true ]; then exit 1; fi\nexit 0\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(
          join(fakeBin, 'stat'),
          '#!/bin/sh\n[ "$2" = "%a" ] && { printf %s 600; exit 0; }\nprintf %s "$(id -u):$(id -g)"\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(join(fakeBin, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      ])

      const executableMigration = migration
        .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
        .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
        .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
        .replace(
          'for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do',
          `for cache_file in ${cloudUserData} ${cloudScript}; do`,
        )
      const result = spawnSync('bash', [], {
        input: executableMigration,
        encoding: 'utf8',
        env: minimalEnvironment({
          PATH: `${fakeBin}:${process.env.PATH}`,
          SYNTHETIC_FAIL_ACTIVE: String(failAfterRestart),
        }),
      })

      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(tokenSentinel))
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-stable-ghcr-value/)
      if (failAfterRestart) {
        assert.notEqual(result.status, 0)
        assert.equal(await readFile(unit, 'utf8'), originalUnit)
        assert.equal(await readFile(cloudUserData, 'utf8'), originalCache)
        assert.equal(await readFile(cloudScript, 'utf8'), originalCache)
        assert.equal(existsSync(dropIn), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(
          await readFile(unit, 'utf8'),
          originalUnit.replace(`${legacyUsernameLine}\n`, '').replace(`${legacyLine}\n`, ''),
        )
        assert.equal(
          await readFile(cloudUserData, 'utf8'),
          originalCache.replace(`${legacyUsernameLine}\n`, '').replace(`${legacyLine}\n`, ''),
        )
        assert.equal(
          await readFile(cloudScript, 'utf8'),
          originalCache.replace(`${legacyUsernameLine}\n`, '').replace(`${legacyLine}\n`, ''),
        )
        const installedWrapper = await readFile(wrapper, 'utf8')
        assert.match(installedWrapper, /if \[ -n "\$\{GHCR_SECRET_ARN:-\}" \]/)
        assert.match(installedWrapper, /export GHCR_TOKEN/)
        assert.doesNotMatch(installedWrapper, new RegExp(tokenSentinel))
        assert.match(await readFile(dropIn, 'utf8'), new RegExp(`Environment=GHCR_SECRET_ARN=${ghcrSecretArn}`))
        assert.match(await readFile(dropIn, 'utf8'), /Environment=GHCR_USERNAME=boxlite-ai/)
        assert.match(await readFile(dropIn, 'utf8'), /ExecStart=\nExecStart=\/usr\/local\/bin\/boxlite-runner-start\.sh/)
        assert.equal((await stat(unit)).mode & 0o777, 0o640)
        assert.equal((await stat(cloudUserData)).mode & 0o777, 0o600)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

test('enables GHCR on a protected extra runner that has no historical wrapper', async () => {
  const { buildExtraRunnerGhcrMigration } = await import('./runtime-secrets-cli.mjs')
  const legacyGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-GhcrPullToken-AbCdEf'
  const ghcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const tokenSentinel = 'synthetic-extra-token-from-before-ghcr-was-enabled'
  const migration = buildExtraRunnerGhcrMigration({
    region: 'ap-southeast-1',
    legacyGhcrSecretArn,
    ghcrSecretArn,
    ghcrEnabled: true,
    ghcrUsername: 'new-owner',
  })

  for (const failAfterRestart of [false, true]) {
    const fixture = await mkdtemp(join(tmpdir(), 'boxlite-extra-runner-ghcr-first-enable-'))
    const fakeBin = join(fixture, 'bin')
    const unit = join(fixture, 'boxlite-runner.service')
    const wrapper = join(fixture, 'boxlite-runner-start.sh')
    const dropInDir = join(fixture, 'boxlite-runner.service.d')
    const dropIn = join(dropInDir, 'ghcr-runtime-secret.conf')
    const cloudUserData = join(fixture, 'cloud-user-data.txt')
    const cloudScript = join(fixture, 'cloud-part-001')
    const tokenLine = `Environment=BOXLITE_RUNNER_TOKEN=${tokenSentinel}`
    const originalUnit = `[Service]\n${tokenLine}\nExecStart=/usr/local/bin/boxlite-runner\n`
    const originalCache = `#!/bin/bash\n${tokenLine}\n`

    try {
      await mkdir(fakeBin, { recursive: true })
      await Promise.all([
        writeFile(unit, originalUnit, { mode: 0o640 }),
        writeFile(cloudUserData, originalCache, { mode: 0o600 }),
        writeFile(cloudScript, originalCache, { mode: 0o600 }),
        writeFile(
          join(fakeBin, 'aws'),
          '#!/bin/sh\nprintf %s synthetic-stable-ghcr-value\n',
          { mode: 0o755 },
        ),
        writeFile(
          join(fakeBin, 'systemctl'),
          '#!/bin/sh\nif [ "$1" = is-active ] && [ "$SYNTHETIC_FAIL_ACTIVE" = true ]; then exit 1; fi\nexit 0\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(
          join(fakeBin, 'stat'),
          '#!/bin/sh\n[ "$2" = "%a" ] && { printf %s 600; exit 0; }\nprintf %s "$(id -u):$(id -g)"\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(join(fakeBin, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      ])

      const executableMigration = migration
        .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
        .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
        .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
        .replace(
          'for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do',
          `for cache_file in ${cloudUserData} ${cloudScript}; do`,
        )
      const result = spawnSync('bash', [], {
        input: executableMigration,
        encoding: 'utf8',
        env: minimalEnvironment({
          PATH: `${fakeBin}:${process.env.PATH}`,
          SYNTHETIC_FAIL_ACTIVE: String(failAfterRestart),
        }),
      })

      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-stable-ghcr-value/)
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(tokenSentinel))
      assert.equal(await readFile(unit, 'utf8'), originalUnit)
      if (failAfterRestart) {
        assert.notEqual(result.status, 0)
        assert.equal(existsSync(wrapper), false)
        assert.equal(existsSync(dropIn), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        const installedWrapper = await readFile(wrapper, 'utf8')
        const installedDropIn = await readFile(dropIn, 'utf8')
        assert.match(installedWrapper, /if \[ -n "\$\{GHCR_SECRET_ARN:-\}" \]/)
        assert.match(installedWrapper, /2>\/dev\/null \|\| true/)
        assert.match(installedWrapper, /export GHCR_TOKEN/)
        assert.doesNotMatch(installedWrapper, new RegExp(tokenSentinel))
        assert.match(installedDropIn, /Environment=GHCR_USERNAME=new-owner/)
        assert.match(installedDropIn, new RegExp(`Environment=GHCR_SECRET_ARN=${ghcrSecretArn}`))
        assert.match(installedDropIn, /ExecStart=\nExecStart=\/usr\/local\/bin\/boxlite-runner-start\.sh/)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

test('disables GHCR on protected extra runners without reading a stable secret', async () => {
  const { buildExtraRunnerGhcrMigration } = await import('./runtime-secrets-cli.mjs')
  const legacyGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-GhcrPullToken-AbCdEf'
  const stableGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const tokenSentinel = 'synthetic-extra-runner-token-preserved-while-ghcr-is-disabled'
  const migration = buildExtraRunnerGhcrMigration({
    region: 'ap-southeast-1',
    legacyGhcrSecretArn,
    ghcrSecretArn: stableGhcrSecretArn,
    ghcrEnabled: false,
    ghcrUsername: '',
  })
  const shellSyntax = spawnSync('bash', ['-n'], { input: migration, encoding: 'utf8' })

  assert.equal(shellSyntax.status, 0, shellSyntax.stderr)
  assert.match(migration, /if \[ -n "\$\{GHCR_SECRET_ARN:-\}" \]/)
  assert.match(migration, new RegExp(Buffer.from(stableGhcrSecretArn).toString('base64')))
  assert.match(migration, /LEGACY_GHCR_SECRET_ARN/)

  for (const failAfterRestart of [false, true]) {
    const fixture = await mkdtemp(join(tmpdir(), 'boxlite-extra-runner-ghcr-disable-'))
    const fakeBin = join(fixture, 'bin')
    const awsMarker = join(fixture, 'aws-was-called')
    const unit = join(fixture, 'boxlite-runner.service')
    const wrapper = join(fixture, 'boxlite-runner-start.sh')
    const dropInDir = join(fixture, 'boxlite-runner.service.d')
    const dropIn = join(dropInDir, 'ghcr-runtime-secret.conf')
    const cloudUserData = join(fixture, 'cloud-user-data.txt')
    const cloudScript = join(fixture, 'cloud-part-001')
    const tokenLine = `Environment=BOXLITE_RUNNER_TOKEN=${tokenSentinel}`
    const legacyLine = `Environment=GHCR_SECRET_ARN=${legacyGhcrSecretArn}`
    const legacyUsernameLine = 'Environment=GHCR_USERNAME=legacy-owner'
    const originalUnit = `[Service]\n${tokenLine}\n${legacyUsernameLine}\n${legacyLine}\nExecStart=${wrapper}\n`
    const originalCache = `#!/bin/bash\n${tokenLine}\n${legacyUsernameLine}\n${legacyLine}\n`
    const stableLine = `Environment=GHCR_SECRET_ARN=${stableGhcrSecretArn}`
    const originalStableCache = `#!/bin/bash\n${tokenLine}\n${legacyUsernameLine}\n${stableLine}\n`
    const originalDropIn = `[Service]\nEnvironment=GHCR_SECRET_ARN=${stableGhcrSecretArn}\n`
    const originalWrapper = '#!/bin/bash\nexec /usr/local/bin/boxlite-runner\n'

    try {
      await Promise.all([mkdir(fakeBin, { recursive: true }), mkdir(dropInDir, { recursive: true })])
      await Promise.all([
        writeFile(unit, originalUnit, { mode: 0o640 }),
        writeFile(wrapper, originalWrapper, { mode: 0o755 }),
        writeFile(cloudUserData, originalCache, { mode: 0o600 }),
        writeFile(cloudScript, originalStableCache, { mode: 0o600 }),
        writeFile(dropIn, originalDropIn, { mode: 0o644 }),
        writeFile(
          join(fakeBin, 'aws'),
          `#!/bin/sh\n: > '${awsMarker}'\nexit 97\n`,
          { mode: 0o755 },
        ),
        writeFile(
          join(fakeBin, 'systemctl'),
          '#!/bin/sh\nif [ "$1" = is-active ] && [ "$SYNTHETIC_FAIL_ACTIVE" = true ]; then exit 1; fi\nexit 0\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(
          join(fakeBin, 'stat'),
          '#!/bin/sh\n[ "$2" = "%a" ] && { printf %s 600; exit 0; }\nprintf %s "$(id -u):$(id -g)"\n',
          { mode: 0o755 },
        ),
        writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(join(fakeBin, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      ])

      const executableMigration = migration
        .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
        .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
        .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
        .replace(
          'for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do',
          `for cache_file in ${cloudUserData} ${cloudScript}; do`,
        )
      const result = spawnSync('bash', [], {
        input: executableMigration,
        encoding: 'utf8',
        env: minimalEnvironment({
          PATH: `${fakeBin}:${process.env.PATH}`,
          SYNTHETIC_FAIL_ACTIVE: String(failAfterRestart),
        }),
      })

      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(tokenSentinel))
      assert.equal(existsSync(awsMarker), false, 'disabled reconciliation must not read Secrets Manager')
      if (failAfterRestart) {
        assert.notEqual(result.status, 0)
        assert.equal(await readFile(unit, 'utf8'), originalUnit)
        assert.equal(await readFile(cloudUserData, 'utf8'), originalCache)
        assert.equal(await readFile(cloudScript, 'utf8'), originalStableCache)
        assert.equal(await readFile(dropIn, 'utf8'), originalDropIn)
        assert.equal(await readFile(wrapper, 'utf8'), originalWrapper)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(
          await readFile(unit, 'utf8'),
          originalUnit.replace(`${legacyUsernameLine}\n`, '').replace(`${legacyLine}\n`, ''),
        )
        assert.equal(
          await readFile(cloudUserData, 'utf8'),
          originalCache.replace(`${legacyUsernameLine}\n`, '').replace(`${legacyLine}\n`, ''),
        )
        assert.equal(
          await readFile(cloudScript, 'utf8'),
          originalStableCache.replace(`${legacyUsernameLine}\n`, '').replace(`${stableLine}\n`, ''),
        )
        assert.equal(existsSync(dropIn), false)
        const installedWrapper = await readFile(wrapper, 'utf8')
        assert.match(installedWrapper, /if \[ -n "\$\{GHCR_SECRET_ARN:-\}" \]/)
        assert.match(installedWrapper, /exec \/usr\/local\/bin\/boxlite-runner/)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

test('migrates runner runtime secrets one host at a time before any binary restart', () => {
  const reconciliation = extractSection(
    LIVE_SST_CONFIG,
    'const extraRunnerGhcrMigrations',
    'if (extraRunners.length > 0)',
  )
  const upgrades = extractSection(
    LIVE_SST_CONFIG,
    'let previousUpgrade:',
    'async function buildRunnerUserData',
  )

  assert.match(
    reconciliation,
    /let previousRunnerSecretMigration:\s*\$util\.Resource \| undefined = defaultRunnerRuntimeSecretMigration/,
  )
  assert.match(
    reconciliation,
    /let previousRunnerRollbackGuard:\s*\$util\.Resource = defaultRunnerLegacyRollbackGuard/,
  )
  assert.match(reconciliation, /for \(const \{ name, instance \} of extraRunners\) \{[\s\S]*ExtraRunnerGhcrLegacyRollbackGuard-/)
  assert.match(
    reconciliation,
    /delete:\s*'node scripts\/runtime-secrets-cli\.mjs restore-extra-runner-ghcr-legacy'/,
  )
  assert.match(reconciliation, /GHCR_SECRET_ARN:\s*runtimeSecretArn\('ghcrPullToken'\)/)
  assert.match(
    reconciliation,
    /dependsOn:\s*\[\s*instance,\s*extraRunnerRuntimeSecretPolicy,\s*defaultRunnerRuntimeSecretPolicy,\s*previousRunnerRollbackGuard,?\s*\]/,
  )
  assert.match(reconciliation, /previousRunnerRollbackGuard = rollbackGuard/)
  assert.match(reconciliation, /if \(deploysRunner\) \{\s*for \(const \{ name, instance \} of extraRunners\)/)
  assert.match(reconciliation, /reconcile-extra-runner-ghcr/)
  assert.match(reconciliation, /SST_STAGE:\s*\$app\.stage/)
  assert.match(reconciliation, /GHCR_ENABLED:\s*ghcrUsername\s*\?\s*'true'\s*:\s*'false'/)
  assert.match(reconciliation, /GHCR_USERNAME:\s*ghcrUsername/)
  assert.match(reconciliation, /LEGACY_GHCR_SECRET_ARN:\s*legacyGhcrSecret\.arn/)
  assert.match(
    reconciliation,
    /GHCR_SECRET_ARN:\s*ghcrUsername\s*\?\s*runtimeSecretArn\('ghcrPullToken'\)\s*:\s*runtimeSecrets\.ghcrPullToken\.arn/,
  )
  assert.match(reconciliation, /triggers:[\s\S]*legacyGhcrSecret\.arn,\s*ghcrUsername,/)
  assert.match(
    reconciliation,
    /ghcrUsername\s*\?\s*runtimeSecretGeneration\(runtimeSecretGenerations,\s*'ghcrPullToken'\)\s*:\s*'disabled'/,
  )
  assert.match(
    reconciliation,
    /dependsOn:\s*\[\s*rollbackGuard,\s*instance,\s*extraRunnerRuntimeSecretPolicy,\s*\.\.\.\(previousRunnerSecretMigration\s*\?\s*\[previousRunnerSecretMigration\]\s*:\s*\[\]\),?\s*\]/,
  )
  assert.match(
    reconciliation,
    /extraRunnerGhcrMigrations\.push\(migration\)\s*previousRunnerSecretMigration = migration/,
  )
  assert.doesNotMatch(reconciliation, /BOXLITE_RUNNER_TOKEN(?:_SECRET_ARN)?\s*:/)
  assert.match(upgrades, /dependsOn:\s*\[\s*instance,\s*artifactPolicy,\s*\.\.\.extraRunnerGhcrMigrations,/)
})

test('converges the existing default runner to an ARN-only systemd drop-in', async () => {
  const { buildDefaultRunnerSecretMigration } = await import('./runtime-secrets-cli.mjs')
  const runnerTokenSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/default-runner-api-key-AbCdEf'
  const ghcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const script = buildDefaultRunnerSecretMigration({
    region: 'ap-southeast-1',
    runnerTokenSecretArn,
    ghcrSecretArn,
    ghcrUsername: 'boxlite-ai',
  })
  const shellSyntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  const extraRolePolicy = extractSection(
    LIVE_SST_CONFIG,
    "const extraRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('ExtraRunnerRuntimeSecretPolicy'",
    "const defaultRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('DefaultRunnerRuntimeSecretPolicy'",
  )
  const defaultRolePolicy = extractSection(
    LIVE_SST_CONFIG,
    "const defaultRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('DefaultRunnerRuntimeSecretPolicy'",
    'const runnerUserData =',
  )
  const migrationCommand = extractSection(
    LIVE_SST_CONFIG,
    "'MigrateDefaultRunnerRuntimeSecrets'",
    'const extraRunners =',
  )

  assert.match(extraRolePolicy, /role:\s*extraRunnerRole\.name/)
  assert.match(extraRolePolicy, /Resource:\s*\[legacyGhcrTokenArn,\s*ghcrTokenArn\]/)
  assert.doesNotMatch(extraRolePolicy, /defaultRunnerApiKey|runnerTokenArn/)
  assert.match(defaultRolePolicy, /role:\s*runnerRole\.name/)
  assert.match(defaultRolePolicy, /Action:\s*\['secretsmanager:GetSecretValue'\]/)
  assert.match(defaultRolePolicy, /Resource:\s*\[legacyGhcrTokenArn,\s*ghcrTokenArn\]/)
  assert.match(
    defaultRolePolicy,
    /Resource:\s*runnerTokenArn,[\s\S]*'ec2:SourceInstanceARN':\s*defaultRunnerSourceArn/,
  )
  assert.doesNotMatch(defaultRolePolicy, /Resource:\s*['"]\*['"]|secretsmanager:\*/)
  assert.doesNotMatch(LIVE_SST_CONFIG, /new aws\.iam\.InstanceProfile\('DefaultRunnerProfile'/)
  assert.match(LIVE_SST_CONFIG, /instanceProfile:\s*runnerInstanceProfile\.name/)
  assert.match(LIVE_SST_CONFIG, /instanceProfile:\s*extraRunnerInstanceProfile\.name/)
  assert.equal(script.includes('\0'), false, 'the SSM shell payload must not contain a literal NUL byte')
  assert.equal(shellSyntax.status, 0, shellSyntax.stderr)

  assert.match(migrationCommand, /BOXLITE_RUNNER_TOKEN_SECRET_ARN:\s*runtimeSecretArn\('defaultRunnerApiKey'\)/)
  assert.match(migrationCommand, /GHCR_SECRET_ARN:\s*runtimeSecretArn\('ghcrPullToken'\)/)
  assert.match(
    migrationCommand,
    /dependsOn:\s*\[defaultRunnerLegacyRollbackGuard, defaultRunner, defaultRunnerRuntimeSecretPolicy\]/,
  )
  assert.match(
    migrationCommand,
    /ghcrUsername\s*\?\s*runtimeSecretGeneration\(runtimeSecretGenerations,\s*'ghcrPullToken'\)\s*:\s*'disabled'/,
  )
  assert.match(
    LIVE_SST_CONFIG,
    /let previousUpgrade:\s*\$util\.Resource \| undefined = defaultRunnerRuntimeSecretMigration/,
  )
  assert.doesNotMatch(migrationCommand, /^\s*BOXLITE_RUNNER_TOKEN\s*:/m)
  assert.doesNotMatch(migrationCommand, /^\s*GHCR_TOKEN\s*:/m)

  assert.match(script, /get-secret-value[\s\S]*--secret-id "\$BOXLITE_RUNNER_TOKEN_SECRET_ARN"/)
  assert.match(script, /get-secret-value[\s\S]*--secret-id "\$GHCR_SECRET_ARN"/)
  const mutationBoundary = script.indexOf('WORK=$(mktemp -d)')
  const propagationPreflight = script.slice(0, mutationBoundary)
  assert.ok(mutationBoundary > 0)
  assert.equal((propagationPreflight.match(/for i in \$\(seq 1 30\)/g) ?? []).length, 2)
  assert.match(propagationPreflight, /\[ "\$i" -eq 30 \] \|\| sleep 10/)
  assert.match(propagationPreflight, /get-secret-value[\s\S]*2>\/dev\/null \|\| true/)
  assert.match(
    script,
    /sed -i -e '\/\^Environment=BOXLITE_RUNNER_TOKEN=\/d' -e '\/\^Environment="BOXLITE_RUNNER_TOKEN=\/d' "\$UNIT"/,
  )
  assert.match(script, /\/var\/lib\/cloud\/instances\/\*\/user-data\.txt/)
  assert.match(script, /\/var\/lib\/cloud\/instances\/\*\/scripts\/part-001/)
  assert.match(script, /cp -a "\$cache_file" "\$cache_backup"/)
  assert.match(script, /cp -a "\$cache_backup" "\$cache_file"/)
  assert.match(
    script,
    /sed -i -e '\/\^Environment=BOXLITE_RUNNER_TOKEN=\/d' -e '\/\^Environment="BOXLITE_RUNNER_TOKEN=\/d' "\$cache_file"/,
  )
  assert.match(script, /cache_owner=\$\(stat -c '%u:%g'/)
  assert.match(script, /cache_mode=\$\(stat -c '%a'/)
  assert.match(script, /chown "\$cache_owner" "\$cache_file"/)
  assert.match(script, /chmod "\$cache_mode" "\$cache_file"/)
  assert.match(script, /UnsetEnvironment=BOXLITE_RUNNER_TOKEN GHCR_TOKEN/)
  assert.match(script, /ExecStart=\/usr\/local\/bin\/boxlite-runner-start\.sh/)
  assert.match(script, /systemctl daemon-reload[\s\S]*systemctl restart boxlite-runner/)
  assert.match(script, /trap rollback EXIT/)
  assert.doesNotMatch(script, /^Environment=BOXLITE_RUNNER_TOKEN=/m)
})

test('restores a legacy-compatible default Runner and can migrate it forward again without plaintext', async () => {
  const { buildDefaultRunnerLegacyRollback, buildDefaultRunnerSecretMigration } =
    await import('./runtime-secrets-cli.mjs')
  const runnerTokenSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/default-runner-api-key-AbCdEf'
  const legacyGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-GhcrPullToken-AbCdEf'
  const stableGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const rollbackGuard = extractSection(
    LIVE_SST_CONFIG,
    "'DefaultRunnerLegacyRollbackGuard'",
    'let defaultRunnerRuntimeSecretMigration:',
  )
  const migrationCommand = extractSection(
    LIVE_SST_CONFIG,
    "'MigrateDefaultRunnerRuntimeSecrets'",
    'const extraRunners =',
  )

  assert.match(rollbackGuard, /create:\s*'true'/)
  assert.match(rollbackGuard, /update:\s*'true'/)
  assert.match(
    rollbackGuard,
    /delete:\s*'node scripts\/runtime-secrets-cli\.mjs restore-default-runner-legacy'/,
  )
  assert.match(rollbackGuard, /BOXLITE_RUNNER_TOKEN_SECRET_ARN:\s*runtimeSecretArn\('defaultRunnerApiKey'\)/)
  assert.match(rollbackGuard, /LEGACY_GHCR_SECRET_ARN:\s*legacyGhcrSecret\.arn/)
  assert.match(rollbackGuard, /dependsOn:\s*\[defaultRunner, defaultRunnerRuntimeSecretPolicy\]/)
  assert.match(LIVE_SST_CONFIG, /const defaultRunner = makeRunner\([\s\S]*instanceProfile:\s*runnerInstanceProfile\.name/)
  assert.doesNotMatch(LIVE_SST_CONFIG, /defaultRunnerInstanceProfile/)
  assert.doesNotMatch(rollbackGuard, /^\s*BOXLITE_RUNNER_TOKEN\s*:/m)
  assert.match(
    migrationCommand,
    /dependsOn:\s*\[defaultRunnerLegacyRollbackGuard, defaultRunner, defaultRunnerRuntimeSecretPolicy\]/,
  )

  for (const ghcrUsername of ['boxlite-ai', '']) {
    const rollback = buildDefaultRunnerLegacyRollback({
      region: 'ap-southeast-1',
      runnerTokenSecretArn,
      legacyGhcrSecretArn,
      ghcrUsername,
    })
    const migration = buildDefaultRunnerSecretMigration({
      region: 'ap-southeast-1',
      runnerTokenSecretArn,
      ghcrSecretArn: stableGhcrSecretArn,
      ghcrUsername,
    })
    const shellSyntax = spawnSync('bash', ['-n'], { input: rollback, encoding: 'utf8' })
    assert.equal(shellSyntax.status, 0, shellSyntax.stderr)
    assert.equal(rollback.includes('\0'), false, 'the SSM shell payload must not contain a literal NUL byte')
    assert.match(rollback, /get-secret-value[\s\S]*--secret-id "\$BOXLITE_RUNNER_TOKEN_SECRET_ARN"/)
    assert.match(rollback, /trap rollback EXIT/)
    assert.match(rollback, /rm -f "\$DROPIN"/)

    for (const failAfterRestart of [false, true]) {
      const fixture = await mkdtemp(join(tmpdir(), 'boxlite-default-runner-legacy-rollback-'))
      const fakeBin = join(fixture, 'bin')
      const unit = join(fixture, 'boxlite-runner.service')
      const wrapper = join(fixture, 'boxlite-runner-start.sh')
      const dropInDir = join(fixture, 'boxlite-runner.service.d')
      const dropIn = join(dropInDir, 'runtime-secrets.conf')
      const cloudUserData = join(fixture, 'cloud-user-data.txt')
      const cloudScript = join(fixture, 'cloud-part-001')
      const tokenSentinel = 'synthetic default-runner "token" \\ value that must never be printed'
      const escapedToken = tokenSentinel.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      const originalUnit =
        '[Unit]\nDescription=BoxLite Runner\n[Service]\nType=simple\n' +
        `ExecStart=${wrapper}\n` +
        'Environment=BOXLITE_API_URL=https://api.example.test/api\n' +
        `Environment=BOXLITE_RUNNER_TOKEN_SECRET_ARN=${runnerTokenSecretArn}\n` +
        'Environment=GHCR_USERNAME=boxlite-ai\n' +
        `Environment=GHCR_SECRET_ARN=${stableGhcrSecretArn}\n`
      const originalWrapper =
        '#!/bin/bash\nBOXLITE_RUNNER_TOKEN=$(aws secretsmanager get-secret-value --secret-id "$BOXLITE_RUNNER_TOKEN_SECRET_ARN")\n'
      const originalDropIn =
        `[Service]\nEnvironment=BOXLITE_RUNNER_TOKEN_SECRET_ARN=${runnerTokenSecretArn}\n` +
        `Environment=GHCR_SECRET_ARN=${stableGhcrSecretArn}\nExecStart=\nExecStart=${wrapper}\n`
      const legacyCache = `#!/bin/bash\nEnvironment="BOXLITE_RUNNER_TOKEN=${escapedToken}"\n`

      try {
        await Promise.all([mkdir(fakeBin, { recursive: true }), mkdir(dropInDir, { recursive: true })])
        await Promise.all([
          writeFile(unit, originalUnit, { mode: 0o640 }),
          writeFile(wrapper, originalWrapper, { mode: 0o755 }),
          writeFile(dropIn, originalDropIn, { mode: 0o644 }),
          writeFile(cloudUserData, legacyCache, { mode: 0o600 }),
          writeFile(cloudScript, legacyCache, { mode: 0o600 }),
          writeFile(join(fakeBin, 'aws'), `#!/bin/sh\nprintf %s '${tokenSentinel}'\n`, { mode: 0o755 }),
          writeFile(
            join(fakeBin, 'systemctl'),
            '#!/bin/sh\nif [ "$1" = is-active ] && [ "$SYNTHETIC_FAIL_ACTIVE" = true ]; then exit 1; fi\nexit 0\n',
            { mode: 0o755 },
          ),
          writeFile(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
          writeFile(
            join(fakeBin, 'stat'),
            '#!/bin/sh\n[ "$2" = "%a" ] && { printf %s 640; exit 0; }\nprintf %s "$(id -u):$(id -g)"\n',
            { mode: 0o755 },
          ),
          writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
          writeFile(
            join(fakeBin, 'sed'),
            '#!/bin/sh\n[ "$1" = -i ] || exit 64\nshift\nfor file; do :; done\n/usr/bin/sed "$@" > "$file.rewritten" && /bin/mv "$file.rewritten" "$file"\n',
            { mode: 0o755 },
          ),
        ])

        const executableRollback = rollback
          .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
          .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
          .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
        const result = spawnSync('bash', [], {
          input: executableRollback,
          encoding: 'utf8',
          env: minimalEnvironment({
            PATH: `${fakeBin}:${process.env.PATH}`,
            SYNTHETIC_FAIL_ACTIVE: String(failAfterRestart),
          }),
        })

        assert.equal(`${result.stdout}${result.stderr}`.includes(tokenSentinel), false)
        if (failAfterRestart) {
          assert.notEqual(result.status, 0)
          assert.equal(await readFile(unit, 'utf8'), originalUnit)
          assert.equal(await readFile(wrapper, 'utf8'), originalWrapper)
          assert.equal(await readFile(dropIn, 'utf8'), originalDropIn)
        } else {
          assert.equal(result.status, 0, result.stderr)
          const restoredUnit = await readFile(unit, 'utf8')
          assert.ok(restoredUnit.includes(`Environment="BOXLITE_RUNNER_TOKEN=${escapedToken}"`))
          assert.doesNotMatch(restoredUnit, /BOXLITE_RUNNER_TOKEN_SECRET_ARN/)
          assert.equal(existsSync(dropIn), false)
          assert.equal((await stat(unit)).mode & 0o777, 0o640)
          if (ghcrUsername) {
            assert.match(restoredUnit, new RegExp(`Environment=GHCR_SECRET_ARN=${legacyGhcrSecretArn}`))
            assert.match(restoredUnit, /Environment=GHCR_USERNAME=boxlite-ai/)
            assert.match(restoredUnit, /ExecStart=\/usr\/local\/bin\/boxlite-runner-start\.sh/)
            const restoredWrapper = await readFile(wrapper, 'utf8')
            assert.match(restoredWrapper, /export GHCR_TOKEN/)
            assert.doesNotMatch(restoredWrapper, /BOXLITE_RUNNER_TOKEN(?:_SECRET_ARN)?/)
            assert.doesNotMatch(restoredWrapper, new RegExp(stableGhcrSecretArn))
          } else {
            assert.doesNotMatch(restoredUnit, /GHCR_(?:USERNAME|SECRET_ARN)/)
            assert.match(restoredUnit, /ExecStart=\/usr\/local\/bin\/boxlite-runner/)
            assert.equal(existsSync(wrapper), false)
          }

          const executableMigration = migration
            .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
            .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
            .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
            .replace(
              'for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do',
              `for cache_file in ${cloudUserData} ${cloudScript}; do`,
            )
          const migrationResult = spawnSync('bash', [], {
            input: executableMigration,
            encoding: 'utf8',
            env: minimalEnvironment({
              PATH: `${fakeBin}:${process.env.PATH}`,
              SYNTHETIC_FAIL_ACTIVE: 'false',
            }),
          })

          assert.equal(`${migrationResult.stdout}${migrationResult.stderr}`.includes(tokenSentinel), false)
          assert.equal(migrationResult.status, 0, migrationResult.stderr)
          for (const migratedFile of [unit, cloudUserData, cloudScript]) {
            assert.doesNotMatch(
              await readFile(migratedFile, 'utf8'),
              /^Environment=(?:")?BOXLITE_RUNNER_TOKEN=/m,
            )
          }
          assert.match(await readFile(dropIn, 'utf8'), /BOXLITE_RUNNER_TOKEN_SECRET_ARN=/)
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  }
})

test('restores extra Runners to the retained legacy GHCR contract after their profile rollback', async () => {
  const { buildExtraRunnerGhcrLegacyRollback } = await import('./runtime-secrets-cli.mjs')
  const stableGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf'
  const legacyGhcrSecretArn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-GhcrPullToken-AbCdEf'
  const tokenSentinel = 'synthetic-existing-extra-token-preserved-through-profile-rollback'

  for (const ghcrEnabled of [true, false]) {
    const rollback = buildExtraRunnerGhcrLegacyRollback({
      region: 'ap-southeast-1',
      stableGhcrSecretArn,
      legacyGhcrSecretArn,
      ghcrEnabled,
      ghcrUsername: ghcrEnabled ? 'legacy-owner' : '',
    })
    const shellSyntax = spawnSync('bash', ['-n'], { input: rollback, encoding: 'utf8' })
    assert.equal(shellSyntax.status, 0, shellSyntax.stderr)
    assert.equal(rollback.includes('\0'), false)
    assert.doesNotMatch(rollback, new RegExp(tokenSentinel))

    for (const failAfterRestart of [false, true]) {
      const fixture = await mkdtemp(join(tmpdir(), 'boxlite-extra-runner-ghcr-rollback-'))
      const fakeBin = join(fixture, 'bin')
      const unit = join(fixture, 'boxlite-runner.service')
      const wrapper = join(fixture, 'boxlite-runner-start.sh')
      const dropInDir = join(fixture, 'boxlite-runner.service.d')
      const dropIn = join(dropInDir, 'ghcr-runtime-secret.conf')
      const tokenLine = `Environment=BOXLITE_RUNNER_TOKEN=${tokenSentinel}`
      const stableLine = `Environment=GHCR_SECRET_ARN=${stableGhcrSecretArn}`
      const originalUnit = `[Service]\n${tokenLine}\nEnvironment=GHCR_USERNAME=stable-owner\n${stableLine}\nExecStart=${wrapper}\n`
      const originalWrapper = '#!/bin/bash\nexec /usr/local/bin/boxlite-runner\n'
      const originalDropIn =
        `[Service]\nEnvironment=GHCR_USERNAME=stable-owner\n${stableLine}\n` +
        `ExecStart=\nExecStart=${wrapper}\n`

      try {
        await Promise.all([mkdir(fakeBin, { recursive: true }), mkdir(dropInDir, { recursive: true })])
        await Promise.all([
          writeFile(unit, originalUnit, { mode: 0o640 }),
          writeFile(wrapper, originalWrapper, { mode: 0o755 }),
          writeFile(dropIn, originalDropIn, { mode: 0o644 }),
          writeFile(join(fakeBin, 'aws'), '#!/bin/sh\nprintf %s synthetic-legacy-ghcr-value\n', {
            mode: 0o755,
          }),
          writeFile(
            join(fakeBin, 'systemctl'),
            '#!/bin/sh\nif [ "$1" = is-active ] && [ "$SYNTHETIC_FAIL_ACTIVE" = true ]; then exit 1; fi\nexit 0\n',
            { mode: 0o755 },
          ),
          writeFile(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
          writeFile(
            join(fakeBin, 'stat'),
            '#!/bin/sh\n[ "$2" = "%a" ] && { printf %s 640; exit 0; }\nprintf %s "$(id -u):$(id -g)"\n',
            { mode: 0o755 },
          ),
          writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
          writeFile(join(fakeBin, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        ])

        const executableRollback = rollback
          .replace('UNIT=/etc/systemd/system/boxlite-runner.service', `UNIT=${unit}`)
          .replace('WRAPPER=/usr/local/bin/boxlite-runner-start.sh', `WRAPPER=${wrapper}`)
          .replace('DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d', `DROPIN_DIR=${dropInDir}`)
          .replace(
            'for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do',
            `for cache_file in ${fixture}/missing-user-data ${fixture}/missing-script; do`,
          )
        const result = spawnSync('bash', [], {
          input: executableRollback,
          encoding: 'utf8',
          env: minimalEnvironment({
            PATH: `${fakeBin}:${process.env.PATH}`,
            SYNTHETIC_FAIL_ACTIVE: String(failAfterRestart),
          }),
        })

        assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(tokenSentinel))
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-legacy-ghcr-value/)
        if (failAfterRestart) {
          assert.notEqual(result.status, 0)
          assert.equal(await readFile(unit, 'utf8'), originalUnit)
          assert.equal(await readFile(wrapper, 'utf8'), originalWrapper)
          assert.equal(await readFile(dropIn, 'utf8'), originalDropIn)
        } else {
          assert.equal(result.status, 0, result.stderr)
          assert.equal(await readFile(unit, 'utf8'), `${tokenLine}\n`.replace(/^/, '[Service]\n') + `ExecStart=${wrapper}\n`)
          if (ghcrEnabled) {
            const restoredDropIn = await readFile(dropIn, 'utf8')
            assert.match(restoredDropIn, new RegExp(`Environment=GHCR_SECRET_ARN=${legacyGhcrSecretArn}`))
            assert.match(restoredDropIn, /Environment=GHCR_USERNAME=legacy-owner/)
            assert.doesNotMatch(restoredDropIn, new RegExp(stableGhcrSecretArn))
          } else {
            assert.equal(existsSync(dropIn), false)
          }
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  }
})

test('generated start-wrapper survives first-read failures and then exports both secrets', async () => {
  const { buildDefaultRunnerSecretMigration } = await import('./runtime-secrets-cli.mjs')
  const migration = buildDefaultRunnerSecretMigration({
    region: 'ap-southeast-1',
    runnerTokenSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:runner-AbCdEf',
    ghcrSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:ghcr-AbCdEf',
    ghcrUsername: 'boxlite-ai',
  })
  const wrapper = /cat > "\$WRAPPER" << 'STARTWRAP'\n([\s\S]*?)\nSTARTWRAP/.exec(migration)?.[1]
  assert.ok(wrapper, 'migration must emit the production start-wrapper')

  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-runtime-secret-fetch-retry-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSleep = join(fixture, 'sleep')
  const runnerCount = join(fixture, 'runner-count')
  const ghcrCount = join(fixture, 'ghcr-count')

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const secretId = args[args.indexOf('--secret-id') + 1]
const isRunner = secretId.includes('runner')
const countPath = isRunner ? process.env.SYNTHETIC_RUNNER_COUNT : process.env.SYNTHETIC_GHCR_COUNT
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0
writeFileSync(countPath, String(count + 1))
if (count === 0) process.exit(55)
process.stdout.write(isRunner ? 'synthetic-runner-value' : 'synthetic-ghcr-value')
`,
      'utf8',
    )
    await writeFile(fakeSleep, '#!/bin/sh\nexit 0\n', 'utf8')
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSleep, 0o755)])

    const executableWrapper = wrapper.replace(
      'exec /usr/local/bin/boxlite-runner',
      `printf '%s|%s' "$BOXLITE_RUNNER_TOKEN" "$GHCR_TOKEN"`,
    )
    const result = spawnSync('bash', [], {
      input: executableWrapper,
      encoding: 'utf8',
      env: minimalEnvironment({
        PATH: `${fixture}:${process.env.PATH}`,
        AWS_REGION: 'ap-southeast-1',
        BOXLITE_RUNNER_TOKEN_SECRET_ARN: 'runner-secret-arn',
        GHCR_SECRET_ARN: 'ghcr-secret-arn',
        SYNTHETIC_RUNNER_COUNT: runnerCount,
        SYNTHETIC_GHCR_COUNT: ghcrCount,
      }),
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'synthetic-runner-value|synthetic-ghcr-value')
    assert.equal(await readFile(runnerCount, 'utf8'), '2')
    assert.equal(await readFile(ghcrCount, 'utf8'), '2')
    assert.doesNotMatch(result.stderr, /synthetic-(?:runner|ghcr)-value/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('passes the selected SST stage to every deploy-time Runner upgrade', () => {
  const upgradeCommands = extractSection(
    LIVE_SST_CONFIG,
    'for (const { label, instance, artifactPolicy } of !deploysRunner',
    'async function buildRunnerUserData',
  )

  assert.match(upgradeCommands, /create:\s*'node scripts\/runner-update-binary\.mjs'/)
  assert.match(upgradeCommands, /environment:\s*\{[\s\S]*SST_STAGE:\s*\$app\.stage/)
})

test('every runtime-secret Runner mutation verifies selected-stage ownership before SSM', () => {
  const commands = [
    ['function reconcileExtraRunnerGhcr()', 'function reconcileDefaultRunner()'],
    ['function reconcileDefaultRunner()', 'function restoreDefaultRunnerLegacy()'],
    ['function restoreDefaultRunnerLegacy()', 'function restoreExtraRunnerGhcrLegacy()'],
    ['function restoreExtraRunnerGhcrLegacy()', 'function main(args)'],
  ]
  for (const [start, end] of commands) {
    const command = extractSection(RUNTIME_SECRETS_CLI_SOURCE, start, end)
    assert.match(command, /requiredEnvironment\('SST_STAGE'\)/, `${start} must receive the selected stage`)
    const verify = command.indexOf('verifyRunnerCommandTargets(')
    const send = command.indexOf('sendCommand(')
    assert.notEqual(verify, -1, `${start} must verify EC2 ownership`)
    assert.ok(verify < send, `${start} must verify EC2 ownership before SSM`)
  }

  const defaultRollback = extractSection(
    LIVE_SST_CONFIG,
    "'DefaultRunnerLegacyRollbackGuard'",
    'const migrateDefaultRunnerRuntimeSecrets',
  )
  const defaultReconcile = extractSection(
    LIVE_SST_CONFIG,
    "'MigrateDefaultRunnerRuntimeSecrets'",
    'const extraRunners =',
  )
  for (const command of [defaultRollback, defaultReconcile]) {
    assert.match(command, /SST_STAGE:\s*\$app\.stage/)
  }
})

test('reconcile command submits only ARN-bearing code and prints no remote output', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-runtime-secret-reconcile-'))
  const fakeAws = join(fixture, 'aws')
  const callsPath = join(fixture, 'aws-calls.jsonl')
  const sentinel = 'synthetic-secret-value-that-must-never-print'

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_AWS_CALLS_PATH, JSON.stringify(args) + '\\n')
if (args[0] === 'ec2' && args[1] === 'describe-instances') {
  process.stdout.write(JSON.stringify({ Reservations: [{ Instances: [{
    InstanceId: 'i-0123456789abcdef0',
    State: { Name: 'running' },
    Tags: [
      { Key: 'boxlite:stage', Value: 'dev' },
      { Key: 'boxlite:ssm-role', Value: 'runner' },
    ],
  }] }] }))
}
else if (args[0] === 'ssm' && args[1] === 'send-command') process.stdout.write('command-123\\n')
else if (args[0] === 'ssm' && args[1] === 'get-command-invocation') process.stdout.write('Success\\n')
else process.exit(91)
`,
      'utf8',
    )
    await chmod(fakeAws, 0o755)

    const result = runInfraScript(['scripts/runtime-secrets-cli.mjs', 'reconcile-default-runner'], {
      PATH: `${fixture}:${process.env.PATH}`,
      AWS_REGION: 'ap-southeast-1',
      SST_STAGE: 'dev',
      INSTANCE_ID: 'i-0123456789abcdef0',
      BOXLITE_RUNNER_TOKEN_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/default-runner-api-key-AbCdEf',
      GHCR_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-runtime/ghcr-pull-token-AbCdEf',
      GHCR_USERNAME: 'boxlite-ai',
      SYNTHETIC_AWS_CALLS_PATH: callsPath,
      SYNTHETIC_SECRET_SENTINEL: sentinel,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel))

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
      ['ec2', 'describe-instances'],
      ['ssm', 'send-command'],
      ['ssm', 'get-command-invocation'],
    ])
    assert.equal(calls.flat().includes('StandardOutputContent'), false)
    assert.equal(calls.flat().includes('StandardErrorContent'), false)

    const parameters = calls[1][calls[1].indexOf('--parameters') + 1]
    const encodedScript = /echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(parameters)?.[1]
    assert.ok(encodedScript, 'SSM command must contain one base64-encoded remote script')
    const remoteScript = Buffer.from(encodedScript, 'base64').toString('utf8')
    assert.match(remoteScript, /BOXLITE_RUNNER_TOKEN_SECRET_ARN/)
    assert.match(remoteScript, /GHCR_SECRET_ARN/)
    assert.doesNotMatch(remoteScript, new RegExp(sentinel))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('rejects raw sst secret list before AWS lookup or SST execution', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-secret-list-guard-'))
  const fakeSst = join(fixture, 'sst')
  const fakeAws = join(fixture, 'aws')
  const sstMarker = join(fixture, 'sst-called')
  const awsMarker = join(fixture, 'aws-called')

  try {
    await writeFile(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n', 'utf8')
    await writeFile(fakeAws, '#!/bin/sh\nprintf called > "$SYNTHETIC_AWS_MARKER"\n', 'utf8')
    await Promise.all([chmod(fakeSst, 0o755), chmod(fakeAws, 0o755)])

    const result = runInfraScript(['scripts/sst-with-cloudflare.mjs', 'secret', 'list', '--stage', 'dev'], {
      AWS_CLI_PATH: fakeAws,
      AWS_REGION: 'ap-southeast-1',
      BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
      SST_BIN_PATH: fakeSst,
      SYNTHETIC_AWS_MARKER: awsMarker,
      SYNTHETIC_SST_MARKER: sstMarker,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /secret list[\s\S]*(?:unsafe|disabled|refus|status)/i)
    assert.equal(existsSync(awsMarker), false, 'the rejected listing must not perform an AWS lookup')
    assert.equal(existsSync(sstMarker), false, 'the rejected listing must not launch SST')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('reports names and SET state without requesting or printing secret values', async () => {
  const {
    RUNTIME_SECRET_DEFINITIONS,
    SST_APP_SECRET_NAMES,
    STALE_SST_SECRET_NAMES,
    runtimeSecretName,
    sstSecretStatusParameterName,
  } = await runtimeSecretsModule()
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-runtime-secret-status-'))
  const fakeAws = join(fixture, 'aws')
  const callsPath = join(fixture, 'aws-calls.jsonl')
  const unsetName = runtimeSecretName('dev', 'otelExporterOtlpHeaders')
  const sentinel = 'synthetic-runtime-secret-value-that-must-never-print'

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_AWS_CALLS_PATH, JSON.stringify(args) + '\\n')
if (args[0] === 'secretsmanager' && args[1] === 'describe-secret') {
  const secretIdIndex = args.indexOf('--secret-id')
  if (secretIdIndex === -1 || !args[secretIdIndex + 1]) process.exit(92)
  const name = args[secretIdIndex + 1]
  process.stdout.write(JSON.stringify({
    ARN: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:' + name,
    Name: name,
    Description: process.env.SYNTHETIC_SECRET_SENTINEL,
    VersionIdsToStages: name === process.env.SYNTHETIC_UNSET_SECRET_NAME ? {} : { synthetic: ['AWSCURRENT'] },
  }))
} else if (args[0] === 'ssm' && args[1] === 'get-parameter') {
  const name = args[args.indexOf('--name') + 1]
  if (name.endsWith('/POSTHOG_API_KEY')) {
    process.stderr.write(process.env.SYNTHETIC_SECRET_SENTINEL)
    process.exit(93)
  }
  process.stdout.write(name.endsWith('/STRIPE_SECRET_KEY') ? 'UNSET\\n' : 'SET\\n')
} else {
  process.exit(91)
}
`,
      'utf8',
    )
    await chmod(fakeAws, 0o755)

    const result = runInfraScript(
      ['scripts/runtime-secrets-cli.mjs', 'status', '--stage', 'dev', '--region', 'ap-southeast-1'],
      {
        AWS_CLI_PATH: fakeAws,
        SYNTHETIC_AWS_CALLS_PATH: callsPath,
        SYNTHETIC_SECRET_SENTINEL: sentinel,
        SYNTHETIC_UNSET_SECRET_NAME: unsetName,
      },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${sentinel}|arn:aws:|SecretString`))

    const statuses = result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^(\S+)\s+(SET|UNSET|UNKNOWN)$/.exec(line.trim())
        assert.ok(match, `status output must contain only a stable name and SET/UNSET/UNKNOWN: ${line}`)
        return [match[1], match[2]]
      })
    assert.deepEqual(
      statuses,
      [
        ...RUNTIME_SECRET_DEFINITIONS.map(({ id }) => {
          const name = runtimeSecretName('dev', id)
          return [name, name === unsetName ? 'UNSET' : 'SET']
        }),
        ...SST_APP_SECRET_NAMES.map((name) => [name, name === 'POSTHOG_API_KEY' ? 'UNKNOWN' : 'SET']),
        ...STALE_SST_SECRET_NAMES.map((name) => [name, name === 'STRIPE_SECRET_KEY' ? 'UNSET' : 'SET']),
      ],
    )

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(calls.length, RUNTIME_SECRET_DEFINITIONS.length + SST_APP_SECRET_NAMES.length + STALE_SST_SECRET_NAMES.length)
    for (const call of calls.slice(0, RUNTIME_SECRET_DEFINITIONS.length)) {
      assert.deepEqual(call.slice(0, 2), ['secretsmanager', 'describe-secret'])
      assert.equal(call.includes('get-secret-value'), false)
      assert.equal(call.includes('batch-get-secret-value'), false)
    }
    const metadataCalls = calls.slice(RUNTIME_SECRET_DEFINITIONS.length)
    assert.deepEqual(
      metadataCalls.map((call) => call[call.indexOf('--name') + 1]),
      [...SST_APP_SECRET_NAMES, ...STALE_SST_SECRET_NAMES].map((name) =>
        sstSecretStatusParameterName('dev', name),
      ),
    )
    for (const call of metadataCalls) {
      assert.deepEqual(call.slice(0, 2), ['ssm', 'get-parameter'])
      assert.equal(call.includes('--with-decryption'), false)
      assert.equal(call.includes('get-parameters-by-path'), false)
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('records stage-scoped SST secret metadata around every wrapper-mediated mutation', async () => {
  const { sstSecretStatusParameterName } = await runtimeSecretsModule()
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-sst-secret-metadata-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsCallsPath = join(fixture, 'aws-calls.jsonl')
  const sstCallsPath = join(fixture, 'sst-calls.jsonl')
  const sentinel = 'synthetic-sst-secret-value-that-must-never-print'

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_AWS_CALLS_PATH, JSON.stringify(args) + '\\n')
if (args[0] !== 'ssm' || args[1] !== 'put-parameter') process.exit(91)
`,
      'utf8',
    )
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.SYNTHETIC_SST_CALLS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.SYNTHETIC_SST_FAIL === 'true') process.exit(7)
`,
      'utf8',
    )
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

    const environment = {
      AWS_CLI_PATH: fakeAws,
      AWS_REGION: 'ap-southeast-1',
      BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
      SST_STAGE: 'dev',
      SST_BIN_PATH: fakeSst,
      SYNTHETIC_AWS_CALLS_PATH: awsCallsPath,
      SYNTHETIC_SST_CALLS_PATH: sstCallsPath,
    }
    const setResult = runInfraScript(
      ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'OIDC_CLIENT_ID', '--stage=dev'],
      environment,
      sentinel,
    )
    assert.equal(setResult.status, 0, setResult.stderr)
    assert.doesNotMatch(`${setResult.stdout}${setResult.stderr}`, new RegExp(sentinel))

    const removeResult = runInfraScript(
      ['scripts/sst-with-cloudflare.mjs', 'secret', 'remove', 'OIDC_CLIENT_ID', '--stage', 'dev'],
      environment,
    )
    assert.equal(removeResult.status, 0, removeResult.stderr)

    const failedResult = runInfraScript(
      ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'POSTHOG_API_KEY', '--stage', 'dev'],
      { ...environment, SYNTHETIC_SST_FAIL: 'true' },
      sentinel,
    )
    assert.equal(failedResult.status, 7)

    const awsCalls = (await readFile(awsCallsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      awsCalls.map((call) => ({
        operation: call.slice(0, 2),
        name: call[call.indexOf('--name') + 1],
        value: call[call.indexOf('--value') + 1],
      })),
      [
        {
          operation: ['ssm', 'put-parameter'],
          name: sstSecretStatusParameterName('dev', 'OIDC_CLIENT_ID'),
          value: 'UNKNOWN',
        },
        {
          operation: ['ssm', 'put-parameter'],
          name: sstSecretStatusParameterName('dev', 'OIDC_CLIENT_ID'),
          value: 'SET',
        },
        {
          operation: ['ssm', 'put-parameter'],
          name: sstSecretStatusParameterName('dev', 'OIDC_CLIENT_ID'),
          value: 'UNKNOWN',
        },
        {
          operation: ['ssm', 'put-parameter'],
          name: sstSecretStatusParameterName('dev', 'OIDC_CLIENT_ID'),
          value: 'UNSET',
        },
        {
          operation: ['ssm', 'put-parameter'],
          name: sstSecretStatusParameterName('dev', 'POSTHOG_API_KEY'),
          value: 'UNKNOWN',
        },
      ],
    )
    for (const call of awsCalls) {
      assert.equal(call.includes('--overwrite'), true)
      assert.equal(call.includes('--type') && call[call.indexOf('--type') + 1] === 'String', true)
      assert.doesNotMatch(JSON.stringify(call), new RegExp(sentinel))
    }

    const sstCalls = (await readFile(sstCallsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(sstCalls, [
      ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
      ['secret', 'remove', 'OIDC_CLIENT_ID', '--stage', 'dev'],
      ['secret', 'set', 'POSTHOG_API_KEY', '--stage', 'dev'],
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('removes the exact SST diagnostic log before and after secret mutation success and failure', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-sst-secret-diagnostic-log-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const sentinel = 'synthetic-secret-diagnostic-log-value-that-must-not-remain-or-print'

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] !== 'ssm' || args[1] !== 'put-parameter') process.exit(91)
`,
      'utf8',
    )
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const logPath = process.env.SYNTHETIC_SST_DIAGNOSTIC_LOG
if (existsSync(logPath)) process.exit(81)
mkdirSync(dirname(logPath), { recursive: true })
writeFileSync(logPath, process.env.SYNTHETIC_LOG_SENTINEL)
process.exit(process.env.SYNTHETIC_SST_FAIL === 'true' ? 7 : 0)
`,
      'utf8',
    )
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

    const environment = {
      AWS_CLI_PATH: fakeAws,
      AWS_REGION: 'ap-southeast-1',
      BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
      SST_BIN_PATH: fakeSst,
      SYNTHETIC_LOG_SENTINEL: sentinel,
    }
    await withIsolatedSstDiagnosticLog(async (diagnosticLog, isolatedInfraRoot) => {
      environment.SYNTHETIC_SST_DIAGNOSTIC_LOG = diagnosticLog
      for (const [failure, expectedStatus] of [
        [false, 0],
        [true, 7],
      ]) {
        await writeFile(diagnosticLog, sentinel, 'utf8')
        const result = runInfraScript(
          ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
          { ...environment, SYNTHETIC_SST_FAIL: String(failure) },
          'synthetic-secret-stdin-value-that-must-not-print',
          { cwd: isolatedInfraRoot },
        )
        assert.equal(result.status, expectedStatus, result.stderr)
        assert.equal(existsSync(diagnosticLog), false, `diagnostic log remained after SST failure=${failure}`)
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel))
      }
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('fails closed when the exact SST diagnostic log cannot be removed before or after a mutation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-sst-secret-diagnostic-log-failure-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsMarker = join(fixture, 'aws-called')
  const sstMarker = join(fixture, 'sst-called')

  try {
    await writeFile(fakeAws, '#!/bin/sh\nprintf called > "$SYNTHETIC_AWS_MARKER"\n', 'utf8')
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
writeFileSync(process.env.SYNTHETIC_SST_MARKER, 'called')
mkdirSync(process.env.SYNTHETIC_SST_DIAGNOSTIC_LOG, { recursive: true })
`,
      'utf8',
    )
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

    await withIsolatedSstDiagnosticLog(async (diagnosticLog, isolatedInfraRoot) => {
      const environment = {
        AWS_CLI_PATH: fakeAws,
        AWS_REGION: 'ap-southeast-1',
        BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
        SST_BIN_PATH: fakeSst,
        SYNTHETIC_AWS_MARKER: awsMarker,
        SYNTHETIC_SST_MARKER: sstMarker,
        SYNTHETIC_SST_DIAGNOSTIC_LOG: diagnosticLog,
      }
      await mkdir(diagnosticLog)
      const beforeFailure = runInfraScript(
        ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
        environment,
        'synthetic-secret-stdin-value-that-must-not-print',
        { cwd: isolatedInfraRoot },
      )
      assert.equal(beforeFailure.status, 1)
      assert.match(beforeFailure.stderr, /diagnostic log|secure.*log/i)
      assert.equal(existsSync(awsMarker), false)
      assert.equal(existsSync(sstMarker), false)

      await rm(diagnosticLog, { recursive: true })
      const afterFailure = runInfraScript(
        ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
        environment,
        'synthetic-secret-stdin-value-that-must-not-print',
        { cwd: isolatedInfraRoot },
      )
      assert.equal(afterFailure.status, 1)
      assert.match(afterFailure.stderr, /diagnostic log|secure.*log/i)
      assert.equal(existsSync(awsMarker), true)
      assert.equal(existsSync(sstMarker), true)
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('suppresses native SST stdout and stderr for stdin-only secret mutations', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-sst-secret-output-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const receivedMarker = join(fixture, 'stdin-received')
  const sentinel = 'synthetic-secret-stdin-value-that-upstream-must-not-echo'

  try {
    await writeFile(
      fakeAws,
      '#!/bin/sh\n[ "$1" = ssm ] && [ "$2" = put-parameter ] || exit 91\n',
      'utf8',
    )
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  writeFileSync(process.env.SYNTHETIC_STDIN_RECEIVED, input === process.env.SYNTHETIC_EXPECTED_STDIN ? 'matched' : 'mismatch')
  process.stdout.write(input)
  process.stderr.write(input)
  process.exit(7)
})
`,
      'utf8',
    )
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

    const result = runInfraScript(
      ['scripts/sst-with-cloudflare.mjs', 'secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
      {
        AWS_CLI_PATH: fakeAws,
        AWS_REGION: 'ap-southeast-1',
        BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
        SST_BIN_PATH: fakeSst,
        SYNTHETIC_EXPECTED_STDIN: sentinel,
        SYNTHETIC_STDIN_RECEIVED: receivedMarker,
      },
      sentinel,
    )
    assert.equal(result.status, 7)
    assert.equal(await readFile(receivedMarker, 'utf8'), 'matched', 'the native SST child must still receive stdin')
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('blocks unsafe SST secret argv before logs, AWS metadata, or SST', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-sst-secret-metadata-guard-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsMarker = join(fixture, 'aws-called')
  const sstMarker = join(fixture, 'sst-called')

  try {
    await writeFile(fakeAws, '#!/bin/sh\nprintf called > "$SYNTHETIC_AWS_MARKER"\n', 'utf8')
    await writeFile(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n', 'utf8')
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])
    const environment = {
      AWS_CLI_PATH: fakeAws,
      AWS_REGION: 'ap-southeast-1',
      BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
      SST_BIN_PATH: fakeSst,
      SYNTHETIC_AWS_MARKER: awsMarker,
      SYNTHETIC_SST_MARKER: sstMarker,
    }

    const sentinel = 'synthetic-positional-secret-value-that-must-not-print'

    const rejected = [
      { args: ['secret', 'load', '.env', '--stage', 'dev'] },
      { args: ['secret', 'set', sentinel, '--stage', 'dev'] },
      { args: ['secret', 'set', 'UNREGISTERED_SECRET', '--stage', 'dev'] },
      { args: ['secret', 'remove', 'UNREGISTERED_SECRET', '--stage', 'dev'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID'] },
      { args: ['secret', 'remove', 'OIDC_CLIENT_ID'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID', sentinel, '--stage', 'dev'] },
      { args: ['secret', 'remove', 'OIDC_CLIENT_ID', sentinel, '--stage', 'dev'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--fallback', '--stage', 'dev'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--fallback=true', '--stage', 'dev'] },
      { args: ['secret', 'remove', 'OIDC_CLIENT_ID', '--future-option', '--stage', 'dev'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev', '--stage=dev'] },
      { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'], environment: { SST_STAGE: 'prod' } },
      { args: ['secret', 'remove', 'SSH_PRIVATE_KEY_B64', '--stage', 'dev'] },
      {
        args: [
          'secret',
          'remove',
          'SSH_PRIVATE_KEY_B64',
          '--stage',
          'dev',
          '--confirm',
          'SSH_HOST_KEY_B64',
        ],
      },
    ]
    for (const [index, { args, environment: overrides = {} }] of rejected.entries()) {
      const result = runInfraScript(
        ['scripts/sst-with-cloudflare.mjs', ...args],
        { ...environment, ...overrides },
      )
      assert.equal(result.status, 1, `unsafe mutation case ${index}`)
      assert.match(result.stderr, /secret|metadata|registered|load/i)
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel))
    }
    assert.equal(existsSync(awsMarker), false)
    assert.equal(existsSync(sstMarker), false)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('removes only an allowlisted stale SST secret after exact double confirmation', async () => {
  const { sstSecretStatusParameterName } = await runtimeSecretsModule()
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-stale-secret-removal-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const callsPath = join(fixture, 'sst-calls.jsonl')
  const awsCallsPath = join(fixture, 'aws-calls.jsonl')
  const environment = {
    AWS_CLI_PATH: fakeAws,
    AWS_REGION: 'ap-southeast-1',
    BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
    SST_BIN_PATH: fakeSst,
    SYNTHETIC_AWS_CALLS_PATH: awsCallsPath,
    SYNTHETIC_SST_CALLS_PATH: callsPath,
  }

  try {
    await writeFile(
      fakeAws,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.SYNTHETIC_AWS_CALLS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      'utf8',
    )
    await writeFile(
      fakeSst,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.SYNTHETIC_SST_CALLS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      'utf8',
    )
    await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

    for (const args of [
      ['remove-stale', '--stage', 'dev', '--name', 'NOT_ALLOWLISTED', '--confirm', 'NOT_ALLOWLISTED'],
      ['remove-stale', '--stage', 'dev', '--name', 'SSH_PRIVATE_KEY_B64'],
      ['remove-stale', '--stage', 'dev', '--name', 'SSH_PRIVATE_KEY_B64', '--confirm', 'SSH_HOST_KEY_B64'],
    ]) {
      const rejected = runInfraScript(['scripts/runtime-secrets-cli.mjs', ...args], environment)
      assert.equal(rejected.status, 1, `${args.join(' ')} must be rejected`)
      assert.equal(existsSync(callsPath), false, 'a rejected removal must not launch SST')
    }

    const accepted = runInfraScript(
      [
        'scripts/runtime-secrets-cli.mjs',
        'remove-stale',
        '--stage',
        'dev',
        '--name',
        'SSH_PRIVATE_KEY_B64',
        '--confirm',
        'SSH_PRIVATE_KEY_B64',
      ],
      environment,
    )
    assert.equal(accepted.status, 0, accepted.stderr)

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(calls, [['secret', 'remove', 'SSH_PRIVATE_KEY_B64', '--stage', 'dev']])
    const awsCalls = (await readFile(awsCallsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      awsCalls.map((call) => [call[call.indexOf('--name') + 1], call[call.indexOf('--value') + 1]]),
      [
        [sstSecretStatusParameterName('dev', 'SSH_PRIVATE_KEY_B64'), 'UNKNOWN'],
        [sstSecretStatusParameterName('dev', 'SSH_PRIVATE_KEY_B64'), 'UNSET'],
      ],
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('routes the package secret command to the names-only status CLI', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  assert.equal(packageJson.scripts.secrets, 'node scripts/runtime-secrets-cli.mjs status')
})

test('removes every inert system source-registry input from runtime and operator surfaces', () => {
  const surfaces = [
    ['sst.config.ts', SST_CONFIG_SOURCE],
    [
      'apps/api/src/config/configuration.ts',
      readFileSync(new URL('../../api/src/config/configuration.ts', import.meta.url), 'utf8'),
    ],
    ['apps/infra/.env.example', readFileSync(new URL('../.env.example', import.meta.url), 'utf8')],
  ]
  const inertNames = [
    'BOXLITE_SYSTEM_IMAGE_TAG',
    'BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME',
    'BOXLITE_SYSTEM_SOURCE_REGISTRY_URL',
    'BOXLITE_SYSTEM_SOURCE_REGISTRY_USERNAME',
    'BOXLITE_SYSTEM_SOURCE_REGISTRY_PASSWORD',
    'BOXLITE_SYSTEM_SOURCE_REGISTRY_PROJECT_ID',
    'systemSourceRegistry',
  ]

  for (const [surface, contents] of surfaces) {
    for (const name of inertNames) {
      assert.equal(contents.includes(name), false, `${surface} still exposes inert ${name}`)
    }
  }
})
