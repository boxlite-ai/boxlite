import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClickHouseExporter } from './clickhouse-exporter'

test('leaves ClickHouse export disabled when no writer config is present', () => {
  assert.deepEqual(resolveClickHouseExporter({}), {
    enabled: false,
    exporters: '[boxlite_exporter]',
    writerEndpoint: undefined,
    writerPassword: undefined,
  })
})

test('auto-enables ClickHouse export when writer endpoint and password are present', () => {
  assert.deepEqual(
    resolveClickHouseExporter({
      CLICKHOUSE_WRITER_ENDPOINT: 'https://writer.example:8443',
      CLICKHOUSE_WRITER_PASSWORD: 'secret',
    }),
    {
      enabled: true,
      exporters: '[boxlite_exporter,clickhouse]',
      writerEndpoint: 'https://writer.example:8443',
      writerPassword: 'secret',
    },
  )
})

test('keeps legacy unprefixed and OTEL endpoint fallbacks working', () => {
  assert.deepEqual(
    resolveClickHouseExporter({
      CLICKHOUSE_OTEL_ENDPOINT: 'https://otel.example:8443',
      CLICKHOUSE_PASSWORD: 'secret',
    }),
    {
      enabled: true,
      exporters: '[boxlite_exporter,clickhouse]',
      writerEndpoint: 'https://otel.example:8443',
      writerPassword: 'secret',
    },
  )
})

test('fails fast when only part of the writer config is present', () => {
  assert.throws(
    () =>
      resolveClickHouseExporter({
        CLICKHOUSE_WRITER_ENDPOINT: 'https://writer.example:8443',
      }),
    /ClickHouse writer endpoint and password must be configured together/,
  )
})

test('fails fast when explicit true is set without writer config', () => {
  assert.throws(
    () =>
      resolveClickHouseExporter({
        CLICKHOUSE_EXPORTER_ENABLED: 'true',
      }),
    /ClickHouse writer endpoint and password must be configured together/,
  )
})

test('allows an explicit false flag to force ClickHouse export off', () => {
  assert.deepEqual(
    resolveClickHouseExporter({
      CLICKHOUSE_EXPORTER_ENABLED: 'false',
      CLICKHOUSE_WRITER_ENDPOINT: 'https://writer.example:8443',
      CLICKHOUSE_WRITER_PASSWORD: 'secret',
    }),
    {
      enabled: false,
      exporters: '[boxlite_exporter]',
      writerEndpoint: 'https://writer.example:8443',
      writerPassword: 'secret',
    },
  )
})

test('keeps explicit true supported when full writer config is present', () => {
  assert.deepEqual(
    resolveClickHouseExporter({
      CLICKHOUSE_EXPORTER_ENABLED: 'true',
      CLICKHOUSE_ENDPOINT: 'https://writer.example:8443',
      CLICKHOUSE_PASSWORD: 'secret',
    }),
    {
      enabled: true,
      exporters: '[boxlite_exporter,clickhouse]',
      writerEndpoint: 'https://writer.example:8443',
      writerPassword: 'secret',
    },
  )
})

test('enables ClickHouse export for the dev fallback before a writer endpoint exists', () => {
  assert.deepEqual(resolveClickHouseExporter({}, { devClickHouseEnabled: true }), {
    enabled: true,
    exporters: '[boxlite_exporter,clickhouse]',
    writerEndpoint: undefined,
    writerPassword: undefined,
  })
})

test('rejects a forced exporter disable when the dev fallback is enabled', () => {
  assert.throws(
    () =>
      resolveClickHouseExporter(
        {
          CLICKHOUSE_EXPORTER_ENABLED: 'false',
        },
        { devClickHouseEnabled: true },
      ),
    /CLICKHOUSE_EXPORTER_ENABLED=false cannot be combined with DEV_CLICKHOUSE_ENABLED=true/,
  )
})
