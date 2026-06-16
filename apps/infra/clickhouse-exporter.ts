export interface ClickHouseExporterResolution {
  enabled: boolean
  exporters: string
  writerEndpoint?: string
  writerPassword?: string
}

export interface ClickHouseExporterOptions {
  devClickHouseEnabled?: boolean
}

type EnvLike = Record<string, string | undefined>

const CLICKHOUSE_EXPORTERS = '[boxlite_exporter,clickhouse]'
const BOXLITE_ONLY_EXPORTERS = '[boxlite_exporter]'

export function resolveClickHouseExporter(
  env: EnvLike,
  options: ClickHouseExporterOptions = {},
): ClickHouseExporterResolution {
  const writerEndpoint = env.CLICKHOUSE_WRITER_ENDPOINT || env.CLICKHOUSE_ENDPOINT || env.CLICKHOUSE_OTEL_ENDPOINT
  const writerPassword = env.CLICKHOUSE_WRITER_PASSWORD || env.CLICKHOUSE_PASSWORD
  const isExplicitlyDisabled = env.CLICKHOUSE_EXPORTER_ENABLED === 'false'
  const isExplicitlyEnabled = env.CLICKHOUSE_EXPORTER_ENABLED === 'true'
  const hasWriterEndpoint = Boolean(writerEndpoint)
  const hasWriterPassword = Boolean(writerPassword)
  const hasPartialWriterConfig = hasWriterEndpoint !== hasWriterPassword

  if (options.devClickHouseEnabled) {
    if (isExplicitlyDisabled) {
      throw new Error('CLICKHOUSE_EXPORTER_ENABLED=false cannot be combined with DEV_CLICKHOUSE_ENABLED=true')
    }
    return {
      enabled: true,
      exporters: CLICKHOUSE_EXPORTERS,
      writerEndpoint,
      writerPassword,
    }
  }

  if (isExplicitlyDisabled) {
    return {
      enabled: false,
      exporters: BOXLITE_ONLY_EXPORTERS,
      writerEndpoint,
      writerPassword,
    }
  }

  if (
    (isExplicitlyEnabled && (!hasWriterEndpoint || !hasWriterPassword)) ||
    (!isExplicitlyEnabled && hasPartialWriterConfig)
  ) {
    throw new Error(
      'ClickHouse writer endpoint and password must be configured together: set CLICKHOUSE_WRITER_ENDPOINT or CLICKHOUSE_ENDPOINT or CLICKHOUSE_OTEL_ENDPOINT, plus CLICKHOUSE_WRITER_PASSWORD or CLICKHOUSE_PASSWORD',
    )
  }

  const enabled = isExplicitlyEnabled || (hasWriterEndpoint && hasWriterPassword)

  return {
    enabled,
    exporters: enabled ? CLICKHOUSE_EXPORTERS : BOXLITE_ONLY_EXPORTERS,
    writerEndpoint,
    writerPassword,
  }
}
