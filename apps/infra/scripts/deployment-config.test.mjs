// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { liveText } from './live-source.mjs'
import { RUNTIME_SECRET_DEFINITIONS } from './runtime-secrets.mjs'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-southeast-1'
const STAGE = 'dev'
const GOLDEN_SOURCE =
  '{"accountId":"123456789012","region":"ap-southeast-1","schemaVersion":1,"stage":"dev","values":{"BOXLITE_RUNTIME_SECRET_GENERATIONS":{"adminApiKey":"generated-pending","clickHouseReaderPassword":"generated-pending","clickHouseWriterPassword":"generated-pending","defaultRunnerApiKey":"generated-pending","encryptionKey":"generated-pending","encryptionSalt":"generated-pending","ghcrPullToken":"generated-pending","otelCollectorApiKey":"generated-pending","otelExporterOtlpHeaders":"generated-pending","pgAdminDefaultPassword":"generated-pending","proxyApiKey":"generated-pending"},"OIDC_AUDIENCE":"boxlite-api","OIDC_ISSUER_BASE_URL":"https://auth.example.test/","STACK_DOMAIN":"dev.example.test"}}'
const GOLDEN_RELEASE_ID = '850b6bc94926cd5d7f3cd70ff090579a02b4b933de8e39cb0c1951d017cd23ba'

const requiredEnvironment = {
  STACK_DOMAIN: 'dev.example.test',
  OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
  OIDC_AUDIENCE: 'boxlite-api',
}
const pendingRuntimeSecretGenerations = Object.fromEntries(
  RUNTIME_SECRET_DEFINITIONS.map(({ id }) => [id, 'generated-pending']),
)
const canonicalPendingRuntimeSecretGenerations = Object.fromEntries(
  Object.entries(pendingRuntimeSecretGenerations).sort(),
)

const SCRIPTS_DIRECTORY = new URL('./', import.meta.url)
const INFRA_CONFIG_PATH = new URL('../sst.config.ts', import.meta.url)
const INFRA_ENV_EXAMPLE_PATH = new URL('../.env.example', import.meta.url)
const POLICIES_DIRECTORY = new URL('../policies/', import.meta.url)

const URL_RELEASE_FIELDS = Object.freeze({
  APP_URL: 'http-url',
  BILLING_API_URL: 'http-url',
  BOXLITE_API_URL: 'http-url',
  BOX_OTEL_ENDPOINT_URL: 'http-url',
  CLICKHOUSE_ENDPOINT: 'http-url',
  CLICKHOUSE_OTEL_ENDPOINT: 'http-url',
  CLICKHOUSE_READER_URL: 'http-url',
  CLICKHOUSE_URL: 'http-url',
  CLICKHOUSE_WRITER_ENDPOINT: 'http-url',
  DASHBOARD_BASE_API_URL: 'http-url',
  DASHBOARD_URL: 'http-url',
  DEFAULT_RUNNER_API_URL: 'http-url',
  DEFAULT_RUNNER_PROXY_URL: 'http-url',
  OIDC_END_SESSION_ENDPOINT: 'http-url',
  OIDC_ISSUER_BASE_URL: 'https-url',
  OIDC_MANAGEMENT_API_BASE_URL: 'http-url',
  OIDC_MANAGEMENT_API_TOKEN_URL: 'http-url',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http-url',
  POSTHOG_HOST: 'http-url',
  PROXY_TEMPLATE_URL: 'http-url',
  PUBLIC_OIDC_DOMAIN: 'https-url',
  SVIX_SERVER_URL: 'http-url',
  USAGE_EXPORT_URL: 'http-url',
})

function createDocumentWithValue(name, value) {
  const environment = { ...requiredEnvironment, [name]: value }
  return configModule().then(({ createDeploymentConfigDocument }) =>
    createDeploymentConfigDocument({
      environment,
      configuredKeys: Object.keys(environment),
      stage: STAGE,
      region: REGION,
      accountId: ACCOUNT_ID,
      runtimeSecretGenerations: pendingRuntimeSecretGenerations,
    }),
  )
}

function configuredExamples(source) {
  const examples = new Map()
  for (const line of source.split('\n')) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=([^\s#]+)(?:\s+#.*)?$/.exec(line)
    if (match) examples.set(match[1], match[2])
  }
  return examples
}

function productionScriptSources(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return productionScriptSources(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
    }
    if (!entry.isFile() || !/\.(?:mjs|cjs|js)$/.test(entry.name) || entry.name.endsWith('.test.mjs')) return []
    return [
      {
        name: `${prefix}${entry.name}`,
        source: readFileSync(new URL(entry.name, directory), 'utf8'),
        kind: 'script',
      },
    ]
  })
}

function environmentReads(name, source, kind = 'script') {
  const liveSource = liveText(kind, source)
  const keys = new Set()
  const computed = new Set()

  for (const match of liveSource.matchAll(/\b(?:process\.env|environment)\.([A-Z][A-Z0-9_]*)\b/g)) {
    keys.add(match[1])
  }
  for (const match of liveSource.matchAll(/\b(?:process\.env|environment)\[\s*(['"])([A-Z][A-Z0-9_]*)\1\s*\]/g)) {
    keys.add(match[2])
  }
  for (const match of liveSource.matchAll(
    /\b(?:envOr|requireEnv|requiredEnvironment|runnerEndpoint)\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g,
  )) {
    keys.add(match[2])
  }
  for (const match of liveSource.matchAll(/\b(?:const|let|var)\s*\{([^{}]+)\}\s*=\s*process\.env\b/g)) {
    for (const property of match[1].split(',')) {
      const key = /^\s*([A-Z][A-Z0-9_]*)\b/.exec(property)?.[1]
      if (key) keys.add(key)
    }
  }
  for (const match of liveSource.matchAll(/\b(process\.env|environment)\[\s*([^\]\n]+?)\s*\]/g)) {
    if (!/^(['"])[A-Z][A-Z0-9_]*\1$/.test(match[2])) computed.add(`${name}:${match[1]}[${match[2]}]`)
  }

  return { keys, computed }
}

async function configModule() {
  return import('./deployment-config.mjs')
}

function documentWithExactCanonicalBytes(targetBytes) {
  const document = {
    accountId: ACCOUNT_ID,
    region: REGION,
    schemaVersion: 1,
    stage: STAGE,
    values: {
      BOXLITE_RUNTIME_SECRET_GENERATIONS: canonicalPendingRuntimeSecretGenerations,
      OIDC_AUDIENCE: '',
      OIDC_ISSUER_BASE_URL: requiredEnvironment.OIDC_ISSUER_BASE_URL,
      STACK_DOMAIN: requiredEnvironment.STACK_DOMAIN,
    },
  }
  const emptySource = JSON.stringify(document)
  const audience = 'a'.repeat(targetBytes - Buffer.byteLength(emptySource, 'utf8'))
  document.values.OIDC_AUDIENCE = audience
  const source = JSON.stringify(document)
  assert.equal(Buffer.byteLength(source, 'utf8'), targetBytes, 'the boundary fixture itself must be exact')
  return document
}

test('publishes one explicit registry and release contract', async () => {
  const {
    DEPLOYMENT_CONFIG_REGISTRY,
    DEPLOYMENT_CONFIG_RELEASE_ENV,
    DEPLOYMENT_CONFIG_SCHEMA_VERSION,
    MAX_DEPLOYMENT_CONFIG_BYTES,
  } = await configModule()

  assert.equal(DEPLOYMENT_CONFIG_SCHEMA_VERSION, 1)
  assert.equal(MAX_DEPLOYMENT_CONFIG_BYTES, 4096)
  assert.equal(DEPLOYMENT_CONFIG_RELEASE_ENV, 'BOXLITE_DEPLOY_CONFIG_RELEASE')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.STACK_DOMAIN.classification, 'release')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.PROXY_API_KEY.classification, 'runtime-secret')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.CLOUDFLARE_API_TOKEN.classification, 'provider-secret')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.BOXLITE_ARTIFACT_SOURCE.classification, 'workflow')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.IAM_PERMISSIONS_BOUNDARY_STAGE.classification, 'derived')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.AWS_PROFILE.classification, 'local-only')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.RUNNER_PRIVATE_IP.classification, 'obsolete')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.SSH_PRIVATE_KEY_B64.classification, 'obsolete')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.SSH_HOST_KEY_B64.classification, 'obsolete')
})

test('requires one nonsecret generation for every stable runtime secret and injects canonical JSON', async () => {
  const {
    RUNTIME_SECRET_GENERATIONS_ENV,
    RUNTIME_SECRET_GENERATION_IDS,
    createDeploymentConfigDocument,
    injectDeploymentConfigEnvironment,
  } = await configModule()
  assert.deepEqual(RUNTIME_SECRET_GENERATION_IDS, RUNTIME_SECRET_DEFINITIONS.map(({ id }) => id).sort())

  const document = createDeploymentConfigDocument({
    environment: requiredEnvironment,
    configuredKeys: Object.keys(requiredEnvironment),
    stage: STAGE,
    region: REGION,
    accountId: ACCOUNT_ID,
    runtimeSecretGenerations: pendingRuntimeSecretGenerations,
  })
  assert.deepEqual(document.values[RUNTIME_SECRET_GENERATIONS_ENV], canonicalPendingRuntimeSecretGenerations)

  const environment = {}
  injectDeploymentConfigEnvironment({ releaseId: 'd'.repeat(64), document }, environment)
  assert.equal(
    environment[RUNTIME_SECRET_GENERATIONS_ENV],
    JSON.stringify(Object.fromEntries(Object.entries(pendingRuntimeSecretGenerations).sort())),
  )

  for (const runtimeSecretGenerations of [
    undefined,
    { ...pendingRuntimeSecretGenerations, unexpectedSecret: 'generated-pending' },
    { ...pendingRuntimeSecretGenerations, encryptionKey: 'not-a-version-id' },
  ]) {
    assert.throws(
      () =>
        createDeploymentConfigDocument({
          environment: requiredEnvironment,
          configuredKeys: Object.keys(requiredEnvironment),
          stage: STAGE,
          region: REGION,
          accountId: ACCOUNT_ID,
          runtimeSecretGenerations,
        }),
      /runtime.*secret.*generation|encryptionKey|unexpectedSecret/i,
    )
  }
})

test('classifies every public endpoint, host component, and protocol with an explicit type', async () => {
  const { DEPLOYMENT_CONFIG_REGISTRY } = await configModule()

  assert.deepEqual(
    Object.fromEntries(Object.keys(URL_RELEASE_FIELDS).map((name) => [name, DEPLOYMENT_CONFIG_REGISTRY[name]?.type])),
    URL_RELEASE_FIELDS,
  )
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.CORS_ALLOWED_ORIGINS.type, 'http-url-list')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST.type, 'http-url-list')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.STACK_DOMAIN.type, 'hostname')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.PROXY_DOMAIN.type, 'hostname')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.DEFAULT_RUNNER_DOMAIN.type, 'host')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.CLICKHOUSE_READER_HOST.type, 'hostname')
  assert.equal(DEPLOYMENT_CONFIG_REGISTRY.CLICKHOUSE_HOST.type, 'hostname')
  for (const name of ['PROXY_PROTOCOL', 'CLICKHOUSE_READER_PROTOCOL', 'CLICKHOUSE_PROTOCOL']) {
    assert.equal(DEPLOYMENT_CONFIG_REGISTRY[name].type, 'http-protocol')
  }

  for (const [name, definition] of Object.entries(DEPLOYMENT_CONFIG_REGISTRY)) {
    if (definition.classification !== 'release' || !/(?:_URL|_ENDPOINT)$/.test(name)) continue
    assert.ok(Object.hasOwn(URL_RELEASE_FIELDS, name), `${name} bypasses the typed public URL boundary`)
  }
})

test('accepts every URL-typed release field and the current operator examples', async () => {
  const examples = configuredExamples(readFileSync(INFRA_ENV_EXAMPLE_PATH, 'utf8'))

  for (const [name] of Object.entries(URL_RELEASE_FIELDS)) {
    const expected = examples.get(name) ?? 'https://endpoint.example.test:8443/a/path/'
    const document = await createDocumentWithValue(name, expected)
    assert.equal(document.values[name], expected, `${name} rejected its current public endpoint shape`)
  }

  for (const name of ['CORS_ALLOWED_ORIGINS', 'OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST']) {
    const expected = examples.get(name) ?? 'http://localhost:5173,https://preview.example.test/path'
    const document = await createDocumentWithValue(name, expected)
    assert.deepEqual(
      document.values[name],
      expected.split(',').sort(),
      `${name} rejected its current public URL-list shape`,
    )
  }
})

test('rejects credentials, queries, and fragments from every URL-typed release field without echoing values', async () => {
  const sentinel = 'url-secret-sentinel-83d190'
  const invalidUrls = [
    `https://operator:${sentinel}@endpoint.example.test/path`,
    `https://endpoint.example.test/path?token=${sentinel}`,
    `https://endpoint.example.test/path#${sentinel}`,
  ]

  for (const name of Object.keys(URL_RELEASE_FIELDS)) {
    for (const value of invalidUrls) {
      await assert.rejects(createDocumentWithValue(name, value), (error) => {
        assert.match(error.message, new RegExp(name))
        assert.equal(error.message.includes(value), false)
        assert.equal(error.message.includes(sentinel), false)
        return true
      })
    }
  }

  for (const name of ['CORS_ALLOWED_ORIGINS', 'OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST']) {
    for (const value of invalidUrls) {
      await assert.rejects(createDocumentWithValue(name, `https://safe.example.test,${value}`), (error) => {
        assert.match(error.message, new RegExp(name))
        assert.equal(error.message.includes(value), false)
        assert.equal(error.message.includes(sentinel), false)
        return true
      })
    }
  }
})

test('rejects a credential-bearing USAGE_EXPORT_URL at the canonical release boundary', async () => {
  const { canonicalizeDeploymentConfig } = await configModule()
  const sentinel = 'usage-export-password-sentinel-9ad827'
  const document = {
    accountId: ACCOUNT_ID,
    region: REGION,
    schemaVersion: 1,
    stage: STAGE,
    values: {
      BOXLITE_RUNTIME_SECRET_GENERATIONS: pendingRuntimeSecretGenerations,
      ...requiredEnvironment,
      USAGE_EXPORT_URL: `https://publisher:${sentinel}@commerce.example.test`,
    },
  }

  assert.throws(() => canonicalizeDeploymentConfig(document), (error) => {
    assert.match(error.message, /USAGE_EXPORT_URL/)
    assert.equal(error.message.includes(sentinel), false)
    return true
  })
})

test('classifies every static production environment read and pins computed reads for review', async () => {
  const { DEPLOYMENT_CONFIG_REGISTRY } = await configModule()
  const sources = [
    {
      name: 'sst.config.ts',
      source: readFileSync(INFRA_CONFIG_PATH, 'utf8'),
      kind: 'scriptEmittingShell',
    },
    ...productionScriptSources(SCRIPTS_DIRECTORY),
    ...productionScriptSources(POLICIES_DIRECTORY, 'policies/'),
  ]
  const ambientOnly = new Set(['PATH'])
  const missing = new Map()
  const computed = new Set()

  for (const source of sources) {
    const reads = environmentReads(source.name, source.source, source.kind)
    for (const key of reads.keys) {
      if (Object.hasOwn(DEPLOYMENT_CONFIG_REGISTRY, key) || ambientOnly.has(key)) continue
      if (!missing.has(key)) missing.set(key, [])
      missing.get(key).push(source.name)
    }
    for (const read of reads.computed) computed.add(read)
  }

  assert.deepEqual(
    [...missing].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    [],
    'every static environment consumer must be classified; PATH is the sole login-shell ambient exception',
  )
  assert.deepEqual([...computed].sort(), [
    'artifact-source.mjs:environment[componentKey]',
    'artifact-source.mjs:environment[key]',
    'bootstrap-consumer-validation.mjs:environment[name]',
    'bootstrap-environment.mjs:environment[envVar]',
    'bootstrap-environment.mjs:process.env[name]',
    'deployment-config-loader.mjs:environment[DEPLOYMENT_CONFIG_RELEASE_ENV]',
    'deployment-config.mjs:environment[DEPLOYMENT_CONFIG_RELEASE_ENV]',
    'deployment-config.mjs:environment[name]',
    'deployment-scope.mjs:environment[DEPLOY_SCOPE_KEY]',
    'runner-artifact.mjs:environment[BUILD_ARTIFACT_BUCKET_KEY]',
    'runner-update-binary.mjs:environment[DEPLOYMENT_OPERATION_LOCK_OWNER_ENV]',
    'runtime-secrets-cli.mjs:process.env[name]',
    'runtime-secrets.mjs:environment[sourceKey]',
    'sst.config.ts:process.env[key]',
  ])
})

test('uses one bounded lowercase stage contract for releases and bootstrap-owned AWS names', async () => {
  const { createDeploymentConfigDocument, deploymentConfigCurrentParameter } = await configModule()
  const create = (stage) =>
    createDeploymentConfigDocument({
      environment: requiredEnvironment,
      configuredKeys: Object.keys(requiredEnvironment),
      stage,
      region: REGION,
      accountId: ACCOUNT_ID,
      runtimeSecretGenerations: pendingRuntimeSecretGenerations,
    })

  assert.equal(create('dev1').stage, 'dev1')
  for (const stage of ['Dev', 'dev_blue', 'dev-blue', 'a'.repeat(21)]) {
    assert.throws(() => create(stage), /stage/i)
    assert.throws(() => deploymentConfigCurrentParameter(stage), /stage/i)
  }
})

test('builds typed release values while excluding every other classified input', async () => {
  const { createDeploymentConfigDocument } = await configModule()
  const environment = {
    ...requiredEnvironment,
    AWS_REGION: REGION,
    IAM_PERMISSIONS_BOUNDARY_STAGE: STAGE,
    OIDC_MANAGEMENT_API_ENABLED: 'true',
    OIDC_MANAGEMENT_API_AUDIENCE: 'https://auth.example.test/api/v2/',
    OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST: 'https://z.example.test, https://a.example.test',
    BOXLITE_SYSTEM_IMAGES: 'zeta=example.test/zeta:1,alpha=example.test/alpha:1',
    RUNNERS: '3',
    PROXY_API_KEY: 'sentinel-runtime-secret',
    BOXLITE_ARTIFACT_SOURCE: 'release',
    RUNNER_PRIVATE_IP: '192.0.2.42',
  }

  const document = createDeploymentConfigDocument({
    environment,
    configuredKeys: Object.keys(environment),
    stage: STAGE,
    region: REGION,
    accountId: ACCOUNT_ID,
    runtimeSecretGenerations: pendingRuntimeSecretGenerations,
  })

  assert.equal(document.schemaVersion, 1)
  assert.equal(document.accountId, ACCOUNT_ID)
  assert.equal(document.region, REGION)
  assert.equal(document.stage, STAGE)
  assert.equal(document.values.OIDC_MANAGEMENT_API_ENABLED, true)
  assert.equal(document.values.RUNNERS, 3)
  assert.deepEqual(document.values.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST, [
    'https://a.example.test',
    'https://z.example.test',
  ])
  assert.deepEqual(document.values.BOXLITE_SYSTEM_IMAGES, {
    alpha: 'example.test/alpha:1',
    zeta: 'example.test/zeta:1',
  })
  assert.equal('PROXY_API_KEY' in document.values, false)
  assert.equal('BOXLITE_ARTIFACT_SOURCE' in document.values, false)
  assert.equal('IAM_PERMISSIONS_BOUNDARY_STAGE' in document.values, false)
  assert.equal('RUNNER_PRIVATE_IP' in document.values, false)
  assert.equal(JSON.stringify(document).includes('sentinel-runtime-secret'), false)
})

test('rejects unclassified bootstrap keys but ignores unrelated ambient process variables', async () => {
  const { createDeploymentConfigDocument } = await configModule()
  const environment = {
    ...requiredEnvironment,
    CI: 'true',
    UNCLASSIFIED_SETTING: 'sentinel-value-that-must-not-be-printed',
  }

  assert.doesNotThrow(() =>
    createDeploymentConfigDocument({
      environment,
      configuredKeys: Object.keys(requiredEnvironment),
      stage: STAGE,
      region: REGION,
      accountId: ACCOUNT_ID,
      runtimeSecretGenerations: pendingRuntimeSecretGenerations,
    }),
  )
  assert.throws(
    () =>
      createDeploymentConfigDocument({
        environment,
        configuredKeys: [...Object.keys(requiredEnvironment), 'UNCLASSIFIED_SETTING'],
        stage: STAGE,
        region: REGION,
        accountId: ACCOUNT_ID,
        runtimeSecretGenerations: pendingRuntimeSecretGenerations,
      }),
    (error) => {
      assert.match(error.message, /UNCLASSIFIED_SETTING/)
      assert.match(error.message, /unclassified|not classified/i)
      assert.equal(error.message.includes(environment.UNCLASSIFIED_SETTING), false)
      return true
    },
  )

  assert.throws(
    () =>
      createDeploymentConfigDocument({
        environment: { ...requiredEnvironment, constructor: 'sentinel-inherited-property-value' },
        configuredKeys: [...Object.keys(requiredEnvironment), 'constructor'],
        stage: STAGE,
        region: REGION,
        accountId: ACCOUNT_ID,
        runtimeSecretGenerations: pendingRuntimeSecretGenerations,
      }),
    (error) => {
      assert.match(error.message, /constructor.*unclassified/i)
      assert.equal(error.message.includes('sentinel-inherited-property-value'), false)
      return true
    },
  )
})

test('requires the core identity values and conditionally required management audience', async () => {
  const { createDeploymentConfigDocument } = await configModule()
  const create = (environment) =>
    createDeploymentConfigDocument({
      environment,
      configuredKeys: Object.keys(environment),
      stage: STAGE,
      region: REGION,
      accountId: ACCOUNT_ID,
      runtimeSecretGenerations: pendingRuntimeSecretGenerations,
    })

  for (const missing of Object.keys(requiredEnvironment)) {
    const environment = { ...requiredEnvironment }
    delete environment[missing]
    assert.throws(() => create(environment), new RegExp(missing))
  }
  assert.throws(
    () => create({ ...requiredEnvironment, OIDC_MANAGEMENT_API_ENABLED: 'true' }),
    /OIDC_MANAGEMENT_API_AUDIENCE/,
  )
  assert.throws(
    () => create({ ...requiredEnvironment, OIDC_MANAGEMENT_API_ENABLED: 'TRUE' }),
    /OIDC_MANAGEMENT_API_ENABLED.*true.*false/i,
  )
})

test('canonicalizes to a fixed byte sequence and stable digest', async () => {
  const { canonicalizeDeploymentConfig, deploymentConfigReleaseId } = await configModule()
  const document = {
    values: {
      BOXLITE_RUNTIME_SECRET_GENERATIONS: pendingRuntimeSecretGenerations,
      STACK_DOMAIN: requiredEnvironment.STACK_DOMAIN,
      OIDC_ISSUER_BASE_URL: requiredEnvironment.OIDC_ISSUER_BASE_URL,
      OIDC_AUDIENCE: requiredEnvironment.OIDC_AUDIENCE,
    },
    stage: STAGE,
    schemaVersion: 1,
    region: REGION,
    accountId: ACCOUNT_ID,
  }

  const source = canonicalizeDeploymentConfig(document)
  assert.equal(source, GOLDEN_SOURCE)
  assert.equal(deploymentConfigReleaseId(source), GOLDEN_RELEASE_ID)
})

test('enforces the Standard Parameter Store limit in UTF-8 bytes', async () => {
  const { canonicalizeDeploymentConfig } = await configModule()

  assert.equal(Buffer.byteLength(canonicalizeDeploymentConfig(documentWithExactCanonicalBytes(4096)), 'utf8'), 4096)
  assert.throws(() => canonicalizeDeploymentConfig(documentWithExactCanonicalBytes(4097)), /4096.*(?:byte|AppConfig)/i)
})

test('validates canonical bytes, digest, document shape, and deployment bindings on read', async () => {
  const { deploymentConfigReleaseId, parseDeploymentConfigRelease } = await configModule()
  const expected = { releaseId: GOLDEN_RELEASE_ID, stage: STAGE, region: REGION, accountId: ACCOUNT_ID }

  const release = parseDeploymentConfigRelease(GOLDEN_SOURCE, expected)
  assert.equal(release.releaseId, GOLDEN_RELEASE_ID)
  assert.equal(release.document.stage, STAGE)

  assert.throws(
    () => parseDeploymentConfigRelease(`${JSON.stringify(JSON.parse(GOLDEN_SOURCE), null, 2)}\n`, expected),
    /canonical/i,
  )
  assert.throws(() => parseDeploymentConfigRelease(GOLDEN_SOURCE, { ...expected, releaseId: 'a'.repeat(64) }), /digest/i)
  assert.throws(() => parseDeploymentConfigRelease(GOLDEN_SOURCE, { ...expected, stage: 'prod' }), /stage/i)
  assert.throws(() => parseDeploymentConfigRelease(GOLDEN_SOURCE, { ...expected, region: 'us-east-1' }), /region/i)
  assert.throws(
    () => parseDeploymentConfigRelease(GOLDEN_SOURCE, { ...expected, accountId: '210987654321' }),
    /account/i,
  )
  const extraFieldSource =
    '{"accountId":"123456789012","region":"ap-southeast-1","schemaVersion":1,"stage":"dev","unexpected":true,"values":{"OIDC_AUDIENCE":"boxlite-api","OIDC_ISSUER_BASE_URL":"https://auth.example.test/","STACK_DOMAIN":"dev.example.test"}}'
  assert.throws(
    () =>
      parseDeploymentConfigRelease(extraFieldSource, {
        ...expected,
        releaseId: deploymentConfigReleaseId(extraFieldSource),
      }),
    /unexpected|shape|field|canonical/i,
  )
})

test('constructs only safe stage paths and makes the release authoritative over ambient config', async () => {
  const {
    deploymentConfigCurrentParameter,
    deploymentConfigReleaseParameter,
    injectDeploymentConfigEnvironment,
    parseDeploymentConfigRelease,
  } = await configModule()
  const release = parseDeploymentConfigRelease(GOLDEN_SOURCE, {
    releaseId: GOLDEN_RELEASE_ID,
    stage: STAGE,
    region: REGION,
    accountId: ACCOUNT_ID,
  })
  const environment = {
    STACK_DOMAIN: 'ambient.example.test',
    POSTHOG_HOST: 'https://ambient.posthog.invalid',
    VERSION: '1.2.3',
  }

  assert.equal(deploymentConfigCurrentParameter(STAGE), '/boxlite/dev/deploy-config/current')
  assert.equal(
    deploymentConfigReleaseParameter(STAGE, GOLDEN_RELEASE_ID),
    `/boxlite/dev/deploy-config/releases/${GOLDEN_RELEASE_ID}`,
  )
  assert.throws(() => deploymentConfigReleaseParameter(STAGE, GOLDEN_RELEASE_ID.toUpperCase()), /release|sha|digest/i)
  assert.throws(() => deploymentConfigCurrentParameter('../prod'), /stage/i)

  assert.equal(injectDeploymentConfigEnvironment(release, environment), environment)
  assert.equal(environment.STACK_DOMAIN, 'dev.example.test')
  assert.equal(environment.POSTHOG_HOST, '', 'an absent optional release value must shield native SST dotenv loading')
  assert.equal(environment.VERSION, '1.2.3', 'workflow-owned values must remain intact')
  assert.equal(environment.BOXLITE_DEPLOY_CONFIG_RELEASE, GOLDEN_RELEASE_ID)
  assert.equal(environment.IAM_PERMISSIONS_BOUNDARY_STAGE, STAGE)
})

test('shields every classified SST input while preserving only sanctioned ambient classes', async () => {
  const { DEPLOYMENT_CONFIG_REGISTRY, shieldSstEnvironment } = await configModule()
  const environment = {
    ADMIN_API_KEY: 'runtime-secret-sentinel',
    CLOUDFLARE_API_TOKEN: 'provider-secret-sentinel',
    SSH_PRIVATE_KEY_B64: 'obsolete-secret-sentinel',
    STACK_DOMAIN: 'ambient-release-sentinel.example.test',
    VERSION: '1.2.3',
    AWS_REGION: REGION,
    AWS_ACCESS_KEY_ID: 'SYNTHETICACCESSKEY',
    BOXLITE_DEPLOY_CONFIG_RELEASE: 'a'.repeat(64),
    PULUMI_OPTION_SHOW_SECRETS: 'ambient-pulumi-secret-sentinel',
    AWS_ENDPOINT_URL_SSM: 'https://ambient-aws-endpoint.invalid',
    LD_PRELOAD: '/ambient/native-injection-sentinel.so',
  }

  assert.equal(shieldSstEnvironment(environment), environment)
  for (const name of Object.keys(DEPLOYMENT_CONFIG_REGISTRY)) {
    assert.equal(Object.hasOwn(environment, name), true, `${name} remains eligible for native SST dotenv Load`)
  }
  for (const name of ['ADMIN_API_KEY', 'CLOUDFLARE_API_TOKEN', 'SSH_PRIVATE_KEY_B64', 'STACK_DOMAIN']) {
    assert.equal(environment[name], '', `${name} retained an untrusted ambient value`)
  }
  for (const name of ['PULUMI_OPTION_SHOW_SECRETS', 'AWS_ENDPOINT_URL_SSM', 'LD_PRELOAD']) {
    assert.equal(environment[name], '', `${name} retained an unsafe native control`)
  }
  assert.equal(environment.VERSION, '1.2.3')
  assert.equal(environment.AWS_REGION, REGION)
  assert.equal(environment.AWS_ACCESS_KEY_ID, 'SYNTHETICACCESSKEY')
  assert.equal(environment.BOXLITE_DEPLOY_CONFIG_RELEASE, 'a'.repeat(64))
})

test('serializes every typed release value into the exact SST environment contract', async () => {
  const { injectDeploymentConfigEnvironment } = await configModule()
  const releaseId = 'c'.repeat(64)
  const release = {
    releaseId,
    document: {
      accountId: ACCOUNT_ID,
      region: REGION,
      schemaVersion: 1,
      stage: STAGE,
      values: {
        BOXLITE_RUNTIME_SECRET_GENERATIONS: pendingRuntimeSecretGenerations,
        BOXLITE_SYSTEM_IMAGES: {
          alpha: 'example.test/alpha:1',
          zeta: 'example.test/zeta:1',
        },
        OIDC_MANAGEMENT_API_ENABLED: true,
        OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST: [
          'https://a.example.test',
          'https://z.example.test',
        ],
        RUNNERS: 3,
      },
    },
  }
  const environment = {}

  injectDeploymentConfigEnvironment(release, environment)

  assert.equal(environment.OIDC_MANAGEMENT_API_ENABLED, 'true')
  assert.equal(environment.RUNNERS, '3')
  assert.equal(
    environment.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST,
    'https://a.example.test,https://z.example.test',
  )
  assert.equal(
    environment.BOXLITE_SYSTEM_IMAGES,
    'alpha=example.test/alpha:1,zeta=example.test/zeta:1',
  )
  assert.equal(environment.BOXLITE_DEPLOY_CONFIG_RELEASE, releaseId)
})
