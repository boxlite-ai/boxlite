// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateBootstrapConsumerInvariants } from './bootstrap-consumer-validation.mjs'

const baseEnvironment = {
  STACK_DOMAIN: 'dev.example.test',
  OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
  OIDC_AUDIENCE: 'boxlite-api',
}

function validate(environment, runtimeSecretSeeds = [], configuredKeys) {
  const effectiveEnvironment = { ...baseEnvironment, ...environment }
  return validateBootstrapConsumerInvariants({
    environment: effectiveEnvironment,
    configuredKeys: configuredKeys ?? Object.keys(effectiveEnvironment),
    runtimeSecretSeeds,
  })
}

test('accepts deployable Proxy, private diagnostic, ClickHouse, and GHCR combinations', () => {
  assert.doesNotThrow(() =>
    validate({
      PROXY_DOMAIN: 'proxy.dev.example.test',
      PROXY_TEMPLATE_URL: 'https://proxy.dev.example.test',
      MAILDEV_PUBLIC: 'false',
      JAEGER_PUBLIC: 'false',
      CLICKHOUSE_EXPORTER_ENABLED: 'true',
      CLICKHOUSE_WRITER_ENDPOINT: 'https://clickhouse.example.test:8443',
      GHCR_USERNAME: 'boxlite-ci',
    }, [
      { id: 'clickHouseWriterPassword', sourceKey: 'CLICKHOUSE_WRITER_PASSWORD', value: 'synthetic' },
      { id: 'ghcrPullToken', sourceKey: 'GHCR_TOKEN', value: 'synthetic-not-a-real-token' },
    ]),
  )
  assert.doesNotThrow(() => validate({ PROXY_TEMPLATE_URL: 'https://proxy.dev.example.test' }))
  for (const endpointKey of ['CLICKHOUSE_WRITER_ENDPOINT', 'CLICKHOUSE_ENDPOINT', 'CLICKHOUSE_OTEL_ENDPOINT']) {
    assert.doesNotThrow(() =>
      validate(
        { CLICKHOUSE_EXPORTER_ENABLED: 'true', [endpointKey]: 'https://clickhouse.example.test:8443' },
        [{ id: 'clickHouseWriterPassword', sourceKey: 'CLICKHOUSE_PASSWORD', value: 'synthetic' }],
      ),
    )
  }
  for (const endpointKey of ['CLICKHOUSE_READER_URL', 'CLICKHOUSE_URL', 'CLICKHOUSE_READER_HOST', 'CLICKHOUSE_HOST']) {
    assert.doesNotThrow(() =>
      validate(
        { [endpointKey]: endpointKey.endsWith('HOST') ? 'clickhouse.example.test' : 'https://clickhouse.example.test' },
        [{ id: 'clickHouseReaderPassword', sourceKey: 'CLICKHOUSE_READER_PASSWORD', value: 'synthetic' }],
      ),
    )
  }
})

test('requires PROXY_TEMPLATE_URL to be the exact HTTPS origin for the effective Proxy domain', () => {
  for (const value of [
    'http://proxy.dev.example.test',
    'https://proxy.dev.example.test:8443',
    'https://proxy.dev.example.test/path',
    'https://proxy.dev.example.test?mode=unsafe',
    'https://proxy.dev.example.test#fragment',
    'https://user@proxy.dev.example.test',
  ]) {
    assert.throws(() => validate({ PROXY_TEMPLATE_URL: value }), /PROXY_TEMPLATE_URL.*HTTPS origin/i)
  }
  assert.throws(
    () =>
      validate({
        PROXY_DOMAIN: 'proxy.dev.example.test',
        PROXY_TEMPLATE_URL: 'https://detached.dev.example.test',
      }),
    /PROXY_TEMPLATE_URL.*host.*PROXY_DOMAIN/i,
  )
})

test('rejects unsupported public diagnostics and incomplete ClickHouse or GHCR activation', () => {
  assert.throws(() => validate({ MAILDEV_PUBLIC: 'true' }), /MAILDEV_PUBLIC.*not supported/i)
  assert.throws(() => validate({ JAEGER_PUBLIC: 'true' }), /JAEGER_PUBLIC.*not supported/i)
  assert.throws(
    () => validate({ CLICKHOUSE_EXPORTER_ENABLED: 'true' }),
    /CLICKHOUSE.*ENDPOINT.*required/i,
  )
  assert.throws(
    () =>
      validate({
        CLICKHOUSE_EXPORTER_ENABLED: 'true',
        CLICKHOUSE_WRITER_ENDPOINT: 'https://clickhouse.example.test:8443',
      }),
    /CLICKHOUSE_WRITER_PASSWORD.*required.*CLICKHOUSE_EXPORTER_ENABLED/i,
  )
  for (const [endpointKey, value] of [
    ['CLICKHOUSE_READER_URL', 'https://clickhouse.example.test'],
    ['CLICKHOUSE_HOST', 'clickhouse.example.test'],
  ]) {
    assert.throws(
      () => validate({ [endpointKey]: value }),
      /CLICKHOUSE_READER_PASSWORD.*required.*reader/i,
    )
  }
  assert.throws(
    () => validate({ GHCR_USERNAME: 'boxlite-ci' }),
    /GHCR_TOKEN.*required.*GHCR_USERNAME/i,
  )
})

test('ignores ambient release-like values that the operator file did not select', () => {
  assert.doesNotThrow(() =>
    validate(
      {
        GHCR_USERNAME: 'ambient-owner',
        MAILDEV_PUBLIC: 'true',
        CLICKHOUSE_EXPORTER_ENABLED: 'true',
      },
      [],
      Object.keys(baseEnvironment),
    ),
  )
})
