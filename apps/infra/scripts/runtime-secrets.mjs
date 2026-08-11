// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { PENDING_RUNTIME_SECRET_GENERATION, validateDeploymentConfigStage } from './deployment-config.mjs'
import { isRuntimeSecretVersionId } from './runtime-secret-version-stages.mjs'

const RESERVED_SECRET_VALUES = new Set(['None', 'unused'])

export const RUNTIME_SECRET_INITIAL_VALUE_TAG = 'boxlite:initial-value'
export const RUNTIME_SECRET_INITIALIZATION_TAG = 'boxlite:initialization'
export const RUNTIME_SECRET_INITIALIZATION_PENDING = 'pending'
export const RUNTIME_SECRET_INITIALIZATION_SEALED = 'sealed'

export { PENDING_RUNTIME_SECRET_GENERATION }

export const RUNTIME_SECRET_DEFINITIONS = [
  {
    id: 'encryptionKey',
    rotationPolicy: 'non-rotatable-v1',
    rotationBlockReason: 'persisted ciphertext has no key-version or re-encryption path',
    environmentKeys: ['ENCRYPTION_KEY'],
    consumers: [{ component: 'Api', environmentKey: 'ENCRYPTION_KEY' }],
  },
  {
    id: 'encryptionSalt',
    rotationPolicy: 'non-rotatable-v1',
    rotationBlockReason: 'persisted ciphertext has no key-version or re-encryption path',
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
    rotationPolicy: 'non-rotatable-v1',
    rotationBlockReason: 'the API database still stores the current default Runner key',
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateRuntimeSecretGeneration(id, value) {
  if (
    typeof value !== 'string' ||
    (value !== PENDING_RUNTIME_SECRET_GENERATION && !isRuntimeSecretVersionId(value))
  ) {
    throw new Error(`runtime secret generation for ${id} must be an AWSCURRENT version id or generated-pending`)
  }
  return value
}

export function parseRuntimeSecretGenerations(serialized) {
  if (typeof serialized !== 'string' || !serialized) {
    throw new Error('BOXLITE_RUNTIME_SECRET_GENERATIONS is required')
  }
  let generations
  try {
    generations = JSON.parse(serialized)
  } catch {
    throw new Error('BOXLITE_RUNTIME_SECRET_GENERATIONS must be valid JSON')
  }
  if (!isPlainObject(generations)) {
    throw new Error('BOXLITE_RUNTIME_SECRET_GENERATIONS must be an object')
  }

  const expectedIds = RUNTIME_SECRET_DEFINITIONS.map(({ id }) => id).sort()
  const actualIds = Object.keys(generations).sort()
  const missingId = expectedIds.find((id) => !Object.hasOwn(generations, id))
  if (missingId) throw new Error(`runtime secret generation map is missing ${missingId}`)
  const unknownId = actualIds.find((id) => !expectedIds.includes(id))
  if (unknownId) throw new Error(`runtime secret generation map contains unknown id ${unknownId}`)

  const validated = {}
  for (const id of expectedIds) {
    validated[id] = validateRuntimeSecretGeneration(id, generations[id])
  }
  return Object.freeze(validated)
}

export function runtimeSecretGeneration(generations, id) {
  if (!RUNTIME_SECRET_DEFINITIONS.some((definition) => definition.id === id)) {
    throw new Error(`unknown runtime secret generation id '${id}'`)
  }
  if (!isPlainObject(generations) || !Object.hasOwn(generations, id)) {
    throw new Error(`runtime secret generation map is missing ${id}`)
  }
  return validateRuntimeSecretGeneration(id, generations[id])
}

export function runtimeSecretGenerationMarker(generations, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('runtime secret generation marker requires at least one secret id')
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('runtime secret generation marker must not contain duplicate secret ids')
  }
  return JSON.stringify(
    Object.fromEntries(
      [...ids]
        .sort()
        .map((id) => [id, runtimeSecretGeneration(generations, id)]),
    ),
  )
}

export const STALE_SST_SECRET_NAMES = [
  'SSH_PRIVATE_KEY_B64',
  'SSH_HOST_KEY_B64',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_PREVIOUS',
]

// SST's native `secret list` prints values, so operators inspect these exact
// registered names through separately maintained, nonsecret SSM metadata.
// Adding a new sst.Secret in sst.config.ts requires adding its name here before
// the wrapper will allow it to be set or removed.
export const SST_APP_SECRET_NAMES = [
  'OIDC_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_SECRET',
  'POSTHOG_API_KEY',
  'SVIX_AUTH_TOKEN',
  'USAGE_EXPORT_TOKEN',
]

export const TRACKED_SST_SECRET_NAMES = [...SST_APP_SECRET_NAMES, ...STALE_SST_SECRET_NAMES]

const SECRET_NAME_SUFFIXES = {
  encryptionKey: 'encryption-key',
  encryptionSalt: 'encryption-salt',
  adminApiKey: 'admin-api-key',
  proxyApiKey: 'proxy-api-key',
  defaultRunnerApiKey: 'default-runner-api-key',
  pgAdminDefaultPassword: 'pg-admin-default-password',
  ghcrPullToken: 'ghcr-pull-token',
  clickHouseWriterPassword: 'click-house-writer-password',
  clickHouseReaderPassword: 'click-house-reader-password',
  otelExporterOtlpHeaders: 'otel-exporter-otlp-headers',
  otelCollectorApiKey: 'otel-collector-api-key',
}

export function runtimeSecretName(stage, id) {
  validateRuntimeSecretStage(stage)
  const suffix = SECRET_NAME_SUFFIXES[id]
  if (!suffix) throw new Error(`unknown runtime secret id '${id}'`)
  return `boxlite-${stage}-runtime/${suffix}`
}

export function validateRuntimeSecretStage(stage) {
  return validateDeploymentConfigStage(stage)
}

export function sstSecretStatusParameterName(stage, name) {
  validateRuntimeSecretStage(stage)
  if (!TRACKED_SST_SECRET_NAMES.includes(name)) {
    throw new Error(`SST secret '${name}' is not registered for safe status metadata`)
  }
  return `/boxlite/${stage}/sst-secret-status/${name}`
}

export function resolveRuntimeSecretSeedValues(environment) {
  const seeds = []
  for (const definition of RUNTIME_SECRET_DEFINITIONS) {
    for (const sourceKey of definition.environmentKeys) {
      const value = environment[sourceKey]
      if (typeof value !== 'string' || value.length === 0) continue
      if (value.trim().length === 0) {
        throw new Error(`${sourceKey} must not contain only whitespace`)
      }
      if (/[\r\n\0]/.test(value)) {
        throw new Error(`${sourceKey} must be a single-line value without NUL bytes`)
      }
      if (RESERVED_SECRET_VALUES.has(value.trim())) {
        throw new Error(`${sourceKey} must not use the reserved placeholder '${value.trim()}'`)
      }
      seeds.push({ id: definition.id, sourceKey, value })
      break
    }
  }
  return seeds
}

export function runtimeSecretNeedsGeneratedInitialVersion(tags) {
  const owner = tags?.[RUNTIME_SECRET_INITIAL_VALUE_TAG]
  const initialization = tags?.[RUNTIME_SECRET_INITIALIZATION_TAG]
  if (owner === 'generated' && initialization === RUNTIME_SECRET_INITIALIZATION_PENDING) return true
  if (
    initialization === RUNTIME_SECRET_INITIALIZATION_SEALED &&
    (owner === 'generated' || owner === 'explicit')
  ) {
    return false
  }
  throw new Error(
    'runtime secret must be tagged boxlite:initial-value=generated|explicit and boxlite:initialization=pending|sealed by bootstrap',
  )
}
