// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { createHash } from 'node:crypto'

export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = 1
export const MAX_DEPLOYMENT_CONFIG_BYTES = 4096
export const DEPLOYMENT_CONFIG_RELEASE_ENV = 'BOXLITE_DEPLOY_CONFIG_RELEASE'
export const RUNTIME_SECRET_GENERATIONS_ENV = 'BOXLITE_RUNTIME_SECRET_GENERATIONS'
export const RUNTIME_SECRET_GENERATION_IDS = Object.freeze([
  'adminApiKey',
  'clickHouseReaderPassword',
  'clickHouseWriterPassword',
  'defaultRunnerApiKey',
  'encryptionKey',
  'encryptionSalt',
  'ghcrPullToken',
  'otelCollectorApiKey',
  'otelExporterOtlpHeaders',
  'pgAdminDefaultPassword',
  'proxyApiKey',
])
export const PENDING_RUNTIME_SECRET_GENERATION = 'generated-pending'

// This stage is used in SSM paths and bootstrap-owned IAM/CloudFormation
// names. Keep it stricter than SST's general workspace-stage grammar so every
// deployment release can be bootstrapped before any external mutation.
const STAGE_PATTERN = /^[a-z0-9]{1,20}$/
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/
const ACCOUNT_ID_PATTERN = /^\d{12}$/
const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/
const SECRET_VERSION_ID_PATTERN = /^[A-Za-z0-9-]{32,64}$/
const SST_AMBIENT_DERIVED_ALLOWLIST = new Set([
  DEPLOYMENT_CONFIG_RELEASE_ENV,
  'BOXLITE_DEPLOY_SCOPE',
  'BOXLITE_RUNNER_STATE_BASELINE',
  'IAM_PERMISSIONS_BOUNDARY_STAGE',
])
const SST_NATIVE_DENIED_AMBIENT_PATTERNS = [
  /^SST_/,
  /^PULUMI_/,
  /^CLOUDFLARE_/,
  /^CF_/,
  /^AWS_ENDPOINT_URL(?:_|$)/,
  /^AWS_(?:SKIP_CREDENTIALS_VALIDATION|SKIP_METADATA_API_CHECK|USE_FIPS_ENDPOINT|USE_DUALSTACK_ENDPOINT|IGNORE_CONFIGURED_ENDPOINT_URLS)$/,
  /^NODE_/,
  /^BUN_/,
  /^LD_/,
  /^DYLD_/,
  /^OTEL_/,
  /^TF_/,
  /^SSLKEYLOGFILE$/,
  /^GRPC_(?:TRACE|VERBOSITY)$/,
]

const release = (type = 'string', options = {}) => ({ classification: 'release', type, ...options })
const classified = (classification, options = {}) => ({ classification, ...options })

/*
 * One registry owns the boundary between bootstrap input and routine deployment.
 * A key cannot silently move into the immutable release merely because a new
 * process.env read was added elsewhere: bootstrap rejects every unclassified
 * key that is present in the operator's file.
 */
export const DEPLOYMENT_CONFIG_REGISTRY = Object.freeze({
  STACK_DOMAIN: release('hostname', { required: true }),
  OIDC_ISSUER_BASE_URL: release('https-url', { required: true }),
  OIDC_AUDIENCE: release('string', { required: true }),
  PUBLIC_OIDC_DOMAIN: release('https-url'),
  RUNNERS: release('integer', { minimum: 1, maximum: 100 }),
  PROXY_DOMAIN: release('hostname'),
  PROXY_PROTOCOL: release('http-protocol', { allowedProtocols: ['https'] }),
  PROXY_TEMPLATE_URL: release('http-url'),
  DEFAULT_TEMPLATE: release(),
  DASHBOARD_URL: release('http-url'),
  DASHBOARD_BASE_API_URL: release('http-url'),
  APP_URL: release('http-url'),
  DEFAULT_RUNNER_NAME: release(),
  DEFAULT_RUNNER_DOMAIN: release('host', { allowPort: true }),
  DEFAULT_RUNNER_API_URL: release('http-url'),
  DEFAULT_RUNNER_PROXY_URL: release('http-url'),
  OIDC_MANAGEMENT_API_ENABLED: release('boolean'),
  OIDC_MANAGEMENT_API_BASE_URL: release('http-url'),
  OIDC_MANAGEMENT_API_TOKEN_URL: release('http-url'),
  OIDC_MANAGEMENT_API_AUDIENCE: release(),
  OIDC_END_SESSION_ENDPOINT: release('http-url'),
  OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST: release('http-url-list'),
  PGADMIN_PUBLIC: release('boolean'),
  PGADMIN_DEFAULT_EMAIL: release(),
  PGADMIN_CONFIG_SERVER_MODE: release(),
  PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: release(),
  JAEGER_PUBLIC: release('boolean'),
  MAILDEV_PUBLIC: release('boolean'),
  CORS_ALLOWED_ORIGINS: release('http-url-list'),
  POSTHOG_HOST: release('http-url'),
  SVIX_SERVER_URL: release('http-url'),
  BILLING_API_URL: release('http-url'),
  USAGE_EXPORT_URL: release('http-url'),
  REQUIRE_PAYMENT_METHOD: release('boolean'),
  CLICKHOUSE_EXPORTER_ENABLED: release('boolean'),
  CLICKHOUSE_WRITER_ENDPOINT: release('http-url'),
  CLICKHOUSE_ENDPOINT: release('http-url'),
  CLICKHOUSE_OTEL_ENDPOINT: release('http-url'),
  CLICKHOUSE_WRITER_USERNAME: release(),
  CLICKHOUSE_USERNAME: release(),
  CLICKHOUSE_WRITER_DATABASE: release(),
  CLICKHOUSE_DATABASE: release(),
  CLICKHOUSE_CREATE_SCHEMA: release('boolean'),
  CLICKHOUSE_COMPRESS: release(),
  CLICKHOUSE_READER_URL: release('http-url'),
  CLICKHOUSE_URL: release('http-url'),
  CLICKHOUSE_READER_HOST: release('hostname'),
  CLICKHOUSE_HOST: release('hostname'),
  CLICKHOUSE_READER_PORT: release('integer', { minimum: 1, maximum: 65535 }),
  CLICKHOUSE_PORT: release('integer', { minimum: 1, maximum: 65535 }),
  CLICKHOUSE_READER_PROTOCOL: release('http-protocol'),
  CLICKHOUSE_PROTOCOL: release('http-protocol'),
  CLICKHOUSE_READER_DATABASE: release(),
  CLICKHOUSE_READER_USERNAME: release(),
  OTEL_ENABLED: release('boolean'),
  OTEL_TRACING_ENABLED: release('boolean'),
  OTEL_EXPORTER_OTLP_ENDPOINT: release('http-url'),
  BOX_OTEL_ENDPOINT_URL: release('http-url'),
  BOXLITE_API_URL: release('http-url'),
  BOXLITE_SYSTEM_BASE_IMAGE: release(),
  BOXLITE_SYSTEM_PYTHON_IMAGE: release(),
  BOXLITE_SYSTEM_NODE_IMAGE: release(),
  BOXLITE_SYSTEM_IMAGES: release('string-map'),
  DEFAULT_REGION_ID: release(),
  GHCR_USERNAME: release(),

  ENCRYPTION_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  ENCRYPTION_SALT: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  ADMIN_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  PROXY_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  DEFAULT_RUNNER_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  GHCR_TOKEN: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  CLICKHOUSE_PASSWORD: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  CLICKHOUSE_WRITER_PASSWORD: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  CLICKHOUSE_READER_PASSWORD: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  OTEL_EXPORTER_OTLP_HEADERS: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  OTEL_COLLECTOR_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  BOXLITE_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  PGADMIN_DEFAULT_PASSWORD: classified('runtime-secret', { bootstrapPublisher: 'secrets-manager' }),
  OIDC_CLIENT_ID: classified('runtime-secret', { bootstrapPublisher: 'sst-secret', allowInteractivePrompt: true }),
  OIDC_MANAGEMENT_API_CLIENT_ID: classified('runtime-secret', { bootstrapPublisher: 'sst-secret' }),
  OIDC_MANAGEMENT_API_CLIENT_SECRET: classified('runtime-secret', { bootstrapPublisher: 'sst-secret' }),
  POSTHOG_API_KEY: classified('runtime-secret', { bootstrapPublisher: 'sst-secret' }),
  SVIX_AUTH_TOKEN: classified('runtime-secret', { bootstrapPublisher: 'sst-secret' }),
  USAGE_EXPORT_TOKEN: classified('runtime-secret', { bootstrapPublisher: 'sst-secret' }),

  CLOUDFLARE_API_TOKEN: classified('provider-secret'),
  CLOUDFLARE_DEFAULT_ACCOUNT_ID: classified('provider-secret'),
  // The native Cloudflare provider reads these controls directly from its
  // inherited environment. None is a supported BoxLite input: in particular,
  // a base-URL or proxy override could redirect requests carrying the
  // bootstrap-owned API token. Predefine them before SST's native dotenv Load
  // and reject them from the operator file.
  CLOUDFLARE_API_KEY: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_API_USER_SERVICE_KEY: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_BASE_URL: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_API_BASE_URL: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_API_URL: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_EMAIL: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_USER_AGENT_OPERATOR_SUFFIX: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_ACCOUNT_ID: classified('provider-secret', { rejectIfConfigured: true }),
  CLOUDFLARE_ZONE_ID: classified('provider-secret', { rejectIfConfigured: true }),
  CF_API_TOKEN: classified('provider-secret', { rejectIfConfigured: true }),
  CF_API_KEY: classified('provider-secret', { rejectIfConfigured: true }),
  CF_API_EMAIL: classified('provider-secret', { rejectIfConfigured: true }),
  CF_API_USER_SERVICE_KEY: classified('provider-secret', { rejectIfConfigured: true }),

  VERSION: classified('workflow'),
  ALLOW_DOWNGRADE: classified('workflow'),
  BOXLITE_ARTIFACT_SOURCE: classified('workflow'),
  BOXLITE_ARTIFACT_REF: classified('workflow'),
  API_ARTIFACT_SOURCE: classified('workflow'),
  API_ARTIFACT_REF: classified('workflow'),
  RUNNER_ARTIFACT_SOURCE: classified('workflow'),
  RUNNER_ARTIFACT_REF: classified('workflow'),
  RUNNER_ARTIFACT_BUCKET: classified('workflow'),
  RUNNER_CREATE_ALLOWLIST: classified('workflow'),
  RUNNER_PORT: classified('workflow'),
  RUNNER_VERSION: classified('workflow'),
  INSTANCE_IDS: classified('workflow'),
  BUILDX_BUILDER: classified('workflow'),
  AWS_REGION: classified('workflow'),
  SST_STAGE: classified('workflow'),
  STAGE: classified('workflow'),

  IAM_PERMISSIONS_BOUNDARY_STAGE: classified('derived'),
  BOXLITE_RUNNER_STATE_BASELINE: classified('derived'),
  BOXLITE_DEPLOY_SCOPE: classified('derived'),
  BOXLITE_DEPLOYMENT_OPERATION_LOCK_OWNER: classified('derived', { rejectIfConfigured: true }),
  API_URL: classified('derived'),
  GHCR_ENABLED: classified('derived'),
  LEGACY_GHCR_SECRET_ARN: classified('derived'),
  REGION_ID: classified('derived'),
  INSTANCE_ID: classified('derived'),
  BOXLITE_RUNNER_TOKEN_SECRET_ARN: classified('derived'),
  GHCR_SECRET_ARN: classified('derived'),
  [DEPLOYMENT_CONFIG_RELEASE_ENV]: classified('derived'),
  [RUNTIME_SECRET_GENERATIONS_ENV]: classified('derived', {
    releaseMetadata: true,
    rejectIfConfigured: true,
    type: 'runtime-secret-generations',
  }),

  AWS_PROFILE: classified('local-only'),
  AWS_CLI_PATH: classified('local-only'),
  AWS_CONFIG_FILE: classified('local-only'),
  AWS_DEFAULT_PROFILE: classified('local-only'),
  AWS_SHARED_CREDENTIALS_FILE: classified('local-only'),
  AWS_ACCESS_KEY_ID: classified('local-only', { rejectIfConfigured: true }),
  AWS_SECRET_ACCESS_KEY: classified('local-only', { rejectIfConfigured: true }),
  AWS_SESSION_TOKEN: classified('local-only', { rejectIfConfigured: true }),
  AWS_ROLE_ARN: classified('local-only', { rejectIfConfigured: true }),
  AWS_WEB_IDENTITY_TOKEN_FILE: classified('local-only', { rejectIfConfigured: true }),
  AWS_CONTAINER_CREDENTIALS_FULL_URI: classified('local-only', { rejectIfConfigured: true }),
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: classified('local-only', { rejectIfConfigured: true }),
  AWS_ENDPOINT_URL: classified('local-only'),
  // These process controls may be supplied deliberately by the invoking
  // workstation/CI environment, but never by the retained bootstrap `.env`.
  // Defining absent keys as empty prevents native SST's dotenv loader from
  // introducing a proxy, trust root, module preload, or Pulumi backend after
  // the wrapper has fetched deployment credentials.
  HTTPS_PROXY: classified('local-only', { rejectIfConfigured: true }),
  HTTP_PROXY: classified('local-only', { rejectIfConfigured: true }),
  ALL_PROXY: classified('local-only', { rejectIfConfigured: true }),
  NO_PROXY: classified('local-only', { rejectIfConfigured: true }),
  https_proxy: classified('local-only', { rejectIfConfigured: true }),
  http_proxy: classified('local-only', { rejectIfConfigured: true }),
  all_proxy: classified('local-only', { rejectIfConfigured: true }),
  no_proxy: classified('local-only', { rejectIfConfigured: true }),
  NODE_OPTIONS: classified('local-only', { rejectIfConfigured: true }),
  NODE_PATH: classified('local-only', { rejectIfConfigured: true }),
  NODE_EXTRA_CA_CERTS: classified('local-only', { rejectIfConfigured: true }),
  SSL_CERT_FILE: classified('local-only', { rejectIfConfigured: true }),
  SSL_CERT_DIR: classified('local-only', { rejectIfConfigured: true }),
  AWS_CA_BUNDLE: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_ACCESS_TOKEN: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_BACKEND_URL: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_CONFIG_PASSPHRASE: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_CONFIG_PASSPHRASE_FILE: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_DEBUG_GRPC: classified('local-only', { rejectIfConfigured: true }),
  PULUMI_HOME: classified('local-only', { rejectIfConfigured: true }),
  SST_BIN_PATH: classified('derived', { rejectIfConfigured: true }),
  BOXLITE_TEST_UNAUDITED_SST_BIN: classified('derived', { rejectIfConfigured: true }),

  RUNNER_PRIVATE_IP: classified('obsolete'),
  SSH_PRIVATE_KEY_B64: classified('obsolete'),
  SSH_HOST_KEY_B64: classified('obsolete'),
  BOXLITE_SYSTEM_IMAGE_TAG: classified('obsolete'),
  BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME: classified('obsolete'),
  BOXLITE_SYSTEM_SOURCE_REGISTRY_URL: classified('obsolete'),
  BOXLITE_SYSTEM_SOURCE_REGISTRY_USERNAME: classified('obsolete'),
  BOXLITE_SYSTEM_SOURCE_REGISTRY_PASSWORD: classified('obsolete', { rejectIfConfigured: true }),
  BOXLITE_SYSTEM_SOURCE_REGISTRY_PROJECT_ID: classified('obsolete'),
})

function requireStage(stage) {
  if (typeof stage !== 'string' || !STAGE_PATTERN.test(stage)) {
    throw new Error(`invalid deployment config stage '${stage ?? ''}'`)
  }
  return stage
}

export function validateDeploymentConfigStage(stage) {
  return requireStage(stage)
}

function requireRegion(region) {
  if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
    throw new Error(`invalid deployment config region '${region ?? ''}'`)
  }
  return region
}

function requireAccountId(accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('deployment config accountId must be a 12-digit AWS account id')
  }
  return accountId
}

function requireReleaseId(releaseId) {
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error('deployment config release must be a lowercase SHA-256 digest')
  }
  return releaseId
}

function normalizeStringList(name, rawValue) {
  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicate entries`)
  return values
}

function normalizeStringMap(name, rawValue) {
  const entries = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=')
      const key = separator > 0 ? entry.slice(0, separator).trim() : ''
      const value = separator > 0 ? entry.slice(separator + 1).trim() : ''
      if (!key || !value) throw new Error(`${name} contains an invalid name=ref entry`)
      return [key, value]
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error(`${name} must not contain duplicate names`)
  }
  return Object.fromEntries(entries)
}

function validateHttpUrl(name, value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty absolute HTTP URL without surrounding whitespace`)
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid absolute HTTP URL`)
  }
  const allowedProtocol = httpsOnly ? url.protocol === 'https:' : url.protocol === 'http:' || url.protocol === 'https:'
  if (!allowedProtocol || !url.hostname) {
    throw new Error(`${name} must use ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} with a hostname`)
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`)
  if (url.search || url.hash) throw new Error(`${name} must not contain a query or fragment`)
  return value
}

function validateHost(name, value, { allowPort = false } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty host without surrounding whitespace`)
  }

  let url
  try {
    url = new URL(`http://${value}`)
  } catch {
    throw new Error(`${name} must be a valid host without a scheme or path`)
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (!allowPort && url.port)
  ) {
    throw new Error(`${name} must be a host${allowPort ? ' with an optional port' : ''} without a scheme or path`)
  }
  return value
}

function validateHttpProtocol(name, value, definition) {
  const allowedProtocols = definition.allowedProtocols ?? ['http', 'https']
  if (typeof value !== 'string' || !allowedProtocols.includes(value)) {
    throw new Error(`${name} must be one of the allowed HTTP protocols: ${allowedProtocols.join(', ')}`)
  }
  return value
}

function normalizeReleaseValue(name, rawValue, definition) {
  if (typeof rawValue !== 'string') throw new Error(`${name} must be configured as a string`)
  const value = rawValue.trim()
  if (!value) return undefined

  if (definition.type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`)
    return value === 'true'
  }
  if (definition.type === 'integer') {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be an integer`)
    const integer = Number.parseInt(value, 10)
    if (!Number.isSafeInteger(integer) || integer < definition.minimum || integer > definition.maximum) {
      throw new Error(`${name} must be between ${definition.minimum} and ${definition.maximum}`)
    }
    return integer
  }
  if (definition.type === 'http-url') return validateHttpUrl(name, value)
  if (definition.type === 'https-url') return validateHttpUrl(name, value, { httpsOnly: true })
  if (definition.type === 'hostname') return validateHost(name, value)
  if (definition.type === 'host') return validateHost(name, value, definition)
  if (definition.type === 'http-protocol') return validateHttpProtocol(name, value, definition)
  if (definition.type === 'http-url-list') {
    const values = normalizeStringList(name, value)
    for (const entry of values) validateHttpUrl(name, entry)
    return values
  }
  if (definition.type === 'string-list') return normalizeStringList(name, value)
  if (definition.type === 'string-map') return normalizeStringMap(name, value)
  return value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateRuntimeSecretGenerations(runtimeSecretGenerations) {
  if (!isPlainObject(runtimeSecretGenerations)) {
    throw new Error('runtime secret generations must be an object')
  }
  const keys = Object.keys(runtimeSecretGenerations).sort()
  if (
    keys.length !== RUNTIME_SECRET_GENERATION_IDS.length ||
    keys.some((key, index) => key !== RUNTIME_SECRET_GENERATION_IDS[index])
  ) {
    throw new Error('runtime secret generations must contain exactly every registered runtime secret id')
  }
  for (const name of keys) {
    const generation = runtimeSecretGenerations[name]
    if (
      generation !== PENDING_RUNTIME_SECRET_GENERATION &&
      (typeof generation !== 'string' || !SECRET_VERSION_ID_PATTERN.test(generation))
    ) {
      throw new Error(`runtime secret generation ${name} must be an AWS Secrets Manager VersionId or pending marker`)
    }
  }
  return Object.fromEntries(keys.map((name) => [name, runtimeSecretGenerations[name]]))
}

function deploymentConfigDefinition(name) {
  return Object.hasOwn(DEPLOYMENT_CONFIG_REGISTRY, name) ? DEPLOYMENT_CONFIG_REGISTRY[name] : undefined
}

function assertTypedReleaseValue(name, value, definition) {
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean in a deployment config release`)
    return
  }
  if (definition.type === 'integer') {
    if (
      !Number.isSafeInteger(value) ||
      value < definition.minimum ||
      value > definition.maximum
    ) {
      throw new Error(`${name} must be an integer between ${definition.minimum} and ${definition.maximum}`)
    }
    return
  }
  if (definition.type === 'http-url') {
    validateHttpUrl(name, value)
    return
  }
  if (definition.type === 'https-url') {
    validateHttpUrl(name, value, { httpsOnly: true })
    return
  }
  if (definition.type === 'hostname') {
    validateHost(name, value)
    return
  }
  if (definition.type === 'host') {
    validateHost(name, value, definition)
    return
  }
  if (definition.type === 'http-protocol') {
    validateHttpProtocol(name, value, definition)
    return
  }
  if (definition.type === 'http-url-list') {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error(`${name} must be an HTTP URL array in a deployment config release`)
    }
    for (const entry of value) validateHttpUrl(name, entry)
    return
  }
  if (definition.type === 'string-list') {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error(`${name} must be a string array in a deployment config release`)
    }
    return
  }
  if (definition.type === 'string-map') {
    if (!isPlainObject(value) || Object.entries(value).some(([key, entry]) => !key || typeof entry !== 'string' || !entry)) {
      throw new Error(`${name} must be a string map in a deployment config release`)
    }
    return
  }
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
}

function validateDocument(document) {
  if (!isPlainObject(document)) throw new Error('deployment config document must be an object')
  const expectedKeys = ['accountId', 'region', 'schemaVersion', 'stage', 'values']
  const keys = Object.keys(document).sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('deployment config document contains an unexpected top-level field or shape')
  }
  if (document.schemaVersion !== DEPLOYMENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported deployment config schemaVersion '${document.schemaVersion}'`)
  }
  requireAccountId(document.accountId)
  requireRegion(document.region)
  requireStage(document.stage)
  if (!isPlainObject(document.values)) throw new Error('deployment config values must be an object')

  for (const [name, value] of Object.entries(document.values)) {
    const definition = deploymentConfigDefinition(name)
    if (!definition || (definition.classification !== 'release' && !definition.releaseMetadata)) {
      throw new Error(`deployment config values contains unexpected field ${name}`)
    }
    if (definition.type === 'runtime-secret-generations') validateRuntimeSecretGenerations(value)
    else assertTypedReleaseValue(name, value, definition)
  }
  for (const [name, definition] of Object.entries(DEPLOYMENT_CONFIG_REGISTRY)) {
    if (definition.classification === 'release' && definition.required && !(name in document.values)) {
      throw new Error(`${name} is required in the deployment config release`)
    }
  }
  if (!Object.hasOwn(document.values, RUNTIME_SECRET_GENERATIONS_ENV)) {
    throw new Error(`${RUNTIME_SECRET_GENERATIONS_ENV} is required in the deployment config release`)
  }
  if (document.values.OIDC_MANAGEMENT_API_ENABLED === true && !document.values.OIDC_MANAGEMENT_API_AUDIENCE) {
    throw new Error('OIDC_MANAGEMENT_API_AUDIENCE is required when OIDC_MANAGEMENT_API_ENABLED=true')
  }
  return document
}

export function createDeploymentConfigDocument({
  environment,
  configuredKeys,
  stage,
  region,
  accountId,
  runtimeSecretGenerations,
}) {
  if (!environment || typeof environment !== 'object') throw new Error('deployment config environment is required')
  if (!Array.isArray(configuredKeys)) throw new Error('deployment config configuredKeys must be an array')

  const selectedStage = requireStage(stage)
  const selectedRegion = requireRegion(region)
  const configuredKeySet = new Set(configuredKeys)
  if (
    configuredKeySet.has('IAM_PERMISSIONS_BOUNDARY_STAGE') &&
    environment.IAM_PERMISSIONS_BOUNDARY_STAGE?.trim() &&
    environment.IAM_PERMISSIONS_BOUNDARY_STAGE.trim() !== selectedStage
  ) {
    throw new Error('IAM_PERMISSIONS_BOUNDARY_STAGE does not match the selected deployment config stage')
  }
  if (
    configuredKeySet.has('SST_STAGE') &&
    environment.SST_STAGE?.trim() &&
    environment.SST_STAGE.trim() !== selectedStage
  ) {
    throw new Error('SST_STAGE does not match the selected deployment config stage')
  }

  const values = {}
  for (const name of [...configuredKeySet].sort()) {
    const definition = deploymentConfigDefinition(name)
    if (!definition) throw new Error(`deployment configuration key ${name} is unclassified`)
    if (definition.rejectIfConfigured) {
      throw new Error(`${name} must not be placed in the bootstrap environment file; use its dedicated secret store`)
    }
    if (
      definition.bootstrapPublisher === 'sst-secret' &&
      !definition.allowInteractivePrompt &&
      (typeof environment[name] !== 'string' || !environment[name].trim())
    ) {
      throw new Error(`${name} is configured for SST secret publication but has no value`)
    }
    if (definition.classification !== 'release') continue
    const normalized = normalizeReleaseValue(name, environment[name], definition)
    if (normalized !== undefined) values[name] = normalized
  }
  values[RUNTIME_SECRET_GENERATIONS_ENV] = validateRuntimeSecretGenerations(runtimeSecretGenerations)

  return validateDocument({
    schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
    accountId: requireAccountId(accountId),
    region: selectedRegion,
    stage: selectedStage,
    values,
  })
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue).sort((left, right) => {
      const leftSource = JSON.stringify(left)
      const rightSource = JSON.stringify(right)
      return leftSource < rightSource ? -1 : leftSource > rightSource ? 1 : 0
    })
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  }
  return value
}

export function canonicalizeDeploymentConfig(document) {
  validateDocument(document)
  const source = JSON.stringify(canonicalValue(document))
  if (typeof source !== 'string') throw new Error('deployment config could not be serialized')
  const size = Buffer.byteLength(source, 'utf8')
  if (size > MAX_DEPLOYMENT_CONFIG_BYTES) {
    throw new Error(
      `deployment config is ${size} bytes; Standard Parameter Store allows 4096 bytes. Adopt AWS AppConfig instead of splitting the release.`,
    )
  }
  return source
}

export function deploymentConfigReleaseId(source) {
  if (typeof source !== 'string') throw new Error('deployment config release source must be a string')
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function parseDeploymentConfigRelease(source, expected) {
  if (typeof source !== 'string') throw new Error('deployment config release source must be a string')
  let document
  try {
    document = JSON.parse(source)
  } catch (cause) {
    throw new Error('deployment config release is not valid JSON', { cause })
  }
  const canonicalSource = canonicalizeDeploymentConfig(document)
  if (canonicalSource !== source) throw new Error('deployment config release bytes are not canonical')
  validateDocument(document)

  const releaseId = deploymentConfigReleaseId(source)
  if (releaseId !== requireReleaseId(expected?.releaseId)) {
    throw new Error('deployment config release digest does not match its immutable parameter name')
  }
  if (document.stage !== requireStage(expected?.stage)) throw new Error('deployment config stage binding does not match')
  if (document.region !== requireRegion(expected?.region)) throw new Error('deployment config region binding does not match')
  if (document.accountId !== requireAccountId(expected?.accountId)) {
    throw new Error('deployment config account binding does not match')
  }
  return { releaseId, document }
}

function serializeEnvironmentValue(name, value) {
  if (Array.isArray(value)) return value.join(',')
  if (name === RUNTIME_SECRET_GENERATIONS_ENV) return JSON.stringify(canonicalValue(value))
  if (isPlainObject(value)) return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join(',')
  return String(value)
}

export function injectDeploymentConfigEnvironment(releaseRecord, environment = process.env) {
  const { releaseId, document } = releaseRecord
  requireReleaseId(releaseId)
  if (!isPlainObject(document) || !isPlainObject(document.values)) {
    throw new Error('deployment config release record has an invalid document')
  }
  requireRegion(document.region)
  requireStage(document.stage)

  shieldSstEnvironment(environment)
  for (const [name, value] of Object.entries(document.values)) {
    environment[name] = serializeEnvironmentValue(name, value)
  }
  environment[DEPLOYMENT_CONFIG_RELEASE_ENV] = releaseId
  environment.AWS_REGION = document.region
  environment.SST_STAGE = document.stage
  environment.IAM_PERMISSIONS_BOUNDARY_STAGE = document.stage
  return environment
}

/*
 * Pinned SST loads a project `.env` with non-overwriting semantics before it
 * evaluates the config. Give every classified name an explicit value so that
 * load cannot reintroduce operator-file values. Release data, credentials,
 * app secrets, obsolete inputs, and internal command handoffs are always
 * cleared; only reviewed workflow/local inputs and the wrapper's own derived
 * handoffs may cross the native-process boundary.
 */
export function shieldSstEnvironment(environment = process.env) {
  if (!environment || typeof environment !== 'object') throw new Error('SST environment must be an object')
  for (const [name, definition] of Object.entries(DEPLOYMENT_CONFIG_REGISTRY)) {
    const preservesAmbient =
      definition.classification === 'workflow' ||
      definition.classification === 'local-only' ||
      (definition.classification === 'derived' && SST_AMBIENT_DERIVED_ALLOWLIST.has(name))
    if (!preservesAmbient || !Object.hasOwn(environment, name)) environment[name] = ''
  }
  // Native SST, Pulumi, language hosts, and bridged providers inherit the
  // complete environment. Clear their control namespaces even when a caller
  // supplied an ambient value: several can redirect credentialed traffic,
  // load arbitrary code/plugins, or write decrypted RPC payloads to an
  // attacker-selected file. BoxLite overlays only its reviewed release and
  // provider values after this boundary.
  for (const name of Object.keys(environment)) {
    if (SST_NATIVE_DENIED_AMBIENT_PATTERNS.some((pattern) => pattern.test(name))) environment[name] = ''
  }
  return environment
}

export function deploymentConfigCurrentParameter(stage) {
  return `/boxlite/${requireStage(stage)}/deploy-config/current`
}

export function deploymentConfigReleaseParameter(stage, releaseId) {
  return `/boxlite/${requireStage(stage)}/deploy-config/releases/${requireReleaseId(releaseId)}`
}
