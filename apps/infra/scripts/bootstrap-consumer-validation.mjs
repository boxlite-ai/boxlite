// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

function configuredValue(environment, configuredKeySet, name) {
  if (!configuredKeySet.has(name)) return ''
  const value = environment[name]
  return typeof value === 'string' ? value.trim() : ''
}

function validateProxyTemplateUrl(environment, configuredKeySet) {
  const configuredTemplateUrl = configuredValue(environment, configuredKeySet, 'PROXY_TEMPLATE_URL')
  if (!configuredTemplateUrl) return

  let templateUrl
  try {
    templateUrl = new URL(configuredTemplateUrl)
  } catch {
    throw new Error('PROXY_TEMPLATE_URL must be an HTTPS origin without credentials, port, path, query, or fragment')
  }
  if (
    templateUrl.protocol !== 'https:' ||
    templateUrl.username ||
    templateUrl.password ||
    templateUrl.port ||
    templateUrl.pathname !== '/' ||
    templateUrl.search ||
    templateUrl.hash
  ) {
    throw new Error('PROXY_TEMPLATE_URL must be an HTTPS origin without credentials, port, path, query, or fragment')
  }

  const stackDomain = configuredValue(environment, configuredKeySet, 'STACK_DOMAIN').toLowerCase()
  const proxyDomain =
    configuredValue(environment, configuredKeySet, 'PROXY_DOMAIN').toLowerCase() || `proxy.${stackDomain}`
  if (templateUrl.hostname !== proxyDomain) {
    throw new Error(
      `PROXY_TEMPLATE_URL host ${templateUrl.hostname} does not match PROXY_DOMAIN ${proxyDomain}`,
    )
  }
}

function validatePrivateDiagnostics(environment, configuredKeySet) {
  for (const name of ['MAILDEV_PUBLIC', 'JAEGER_PUBLIC']) {
    if (configuredValue(environment, configuredKeySet, name) === 'true') {
      throw new Error(`${name}=true is not supported because the service has no deployable public authentication boundary`)
    }
  }
}

function hasRuntimeSecretSeed(runtimeSecretSeeds, id, sourceKeys) {
  return runtimeSecretSeeds.some((seed) => seed?.id === id && sourceKeys.includes(seed.sourceKey))
}

function validateClickHouseConsumers(environment, configuredKeySet, runtimeSecretSeeds) {
  const isWriterEnabled = configuredValue(environment, configuredKeySet, 'CLICKHOUSE_EXPORTER_ENABLED') === 'true'
  const hasWriterEndpoint = [
    'CLICKHOUSE_WRITER_ENDPOINT',
    'CLICKHOUSE_ENDPOINT',
    'CLICKHOUSE_OTEL_ENDPOINT',
  ].some((name) => configuredValue(environment, configuredKeySet, name))
  if (isWriterEnabled && !hasWriterEndpoint) {
    throw new Error(
      'CLICKHOUSE_WRITER_ENDPOINT, CLICKHOUSE_ENDPOINT, or CLICKHOUSE_OTEL_ENDPOINT is required when CLICKHOUSE_EXPORTER_ENABLED=true',
    )
  }
  if (
    isWriterEnabled &&
    !hasRuntimeSecretSeed(runtimeSecretSeeds, 'clickHouseWriterPassword', [
      'CLICKHOUSE_WRITER_PASSWORD',
      'CLICKHOUSE_PASSWORD',
    ])
  ) {
    throw new Error(
      'CLICKHOUSE_WRITER_PASSWORD or CLICKHOUSE_PASSWORD is required as an explicit bootstrap seed when CLICKHOUSE_EXPORTER_ENABLED=true',
    )
  }

  const hasReaderEndpoint = [
    'CLICKHOUSE_READER_URL',
    'CLICKHOUSE_URL',
    'CLICKHOUSE_READER_HOST',
    'CLICKHOUSE_HOST',
  ].some((name) => configuredValue(environment, configuredKeySet, name))
  if (
    hasReaderEndpoint &&
    !hasRuntimeSecretSeed(runtimeSecretSeeds, 'clickHouseReaderPassword', [
      'CLICKHOUSE_READER_PASSWORD',
      'CLICKHOUSE_PASSWORD',
    ])
  ) {
    throw new Error(
      'CLICKHOUSE_READER_PASSWORD or CLICKHOUSE_PASSWORD is required as an explicit bootstrap seed when a ClickHouse reader URL or host is configured',
    )
  }
}

function validateGhcrSeed(environment, configuredKeySet, runtimeSecretSeeds) {
  if (!configuredValue(environment, configuredKeySet, 'GHCR_USERNAME')) return
  const hasExplicitTokenSeed = runtimeSecretSeeds.some(
    (seed) => seed?.id === 'ghcrPullToken' && seed.sourceKey === 'GHCR_TOKEN',
  )
  if (!hasExplicitTokenSeed) {
    throw new Error('GHCR_TOKEN is required as an explicit bootstrap seed when GHCR_USERNAME is configured')
  }
}

export function validateBootstrapConsumerInvariants({ environment, configuredKeys, runtimeSecretSeeds } = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('bootstrap consumer validation requires an environment object')
  }
  if (!Array.isArray(runtimeSecretSeeds)) {
    throw new Error('bootstrap consumer validation requires resolved runtime secret seeds')
  }
  if (!Array.isArray(configuredKeys)) {
    throw new Error('bootstrap consumer validation requires the selected operator-file keys')
  }
  const configuredKeySet = new Set(configuredKeys)
  validateProxyTemplateUrl(environment, configuredKeySet)
  validatePrivateDiagnostics(environment, configuredKeySet)
  validateClickHouseConsumers(environment, configuredKeySet, runtimeSecretSeeds)
  validateGhcrSeed(environment, configuredKeySet, runtimeSecretSeeds)
}
