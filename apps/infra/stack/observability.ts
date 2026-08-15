// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import { IMAGES, PORTS, envOr, httpHealth } from './settings.js'
import type { FoundationResources } from './foundation.js'

export interface ObservabilityInputs {
  cluster: FoundationResources['cluster']
  stackDomain: string
  adminApiKey: random.RandomPassword
  clickHouseWriterEndpoint: string | undefined
  clickHouseWriterPassword: string | undefined
  collectorExporters: string
  collectorTraceExporters: string
  stripTrailingSlash: (url: $util.Output<string>) => $util.Output<string>
}

export function buildObservability(input: ObservabilityInputs) {
  if (envOr('JAEGER_PUBLIC', 'false') === 'true') {
    throw new Error(
      'JAEGER_PUBLIC is not supported: Jaeger has no auth and its UI is plain HTTP, so ' +
        'it cannot be safely exposed to the internet. Reach it via VPN / bastion / ' +
        '`aws ssm start-session`.',
    )
  }
  const jaeger = new sst.aws.Service('Jaeger', {
    cluster: input.cluster,
    image: IMAGES.jaeger,
    loadBalancer: {
      public: false,
      rules: [
        { listen: '80/http', forward: `${PORTS.JAEGER_UI}/http` },
        { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
      ],
      health: {
        [`${PORTS.OTLP_HTTP}/http`]: httpHealth('/', { successCodes: '200-499' }),
      },
    },
    environment: { COLLECTOR_OTLP_ENABLED: 'true' },
  })
  const jaegerOtlpHttpEndpoint = input
    .stripTrailingSlash(jaeger.url)
    .apply((url) => `${url}:${PORTS.OTLP_HTTP}`)

  const otelCollector = new sst.aws.Service('OtelCollector', {
    cluster: input.cluster,
    image: { context: '../..', dockerfile: 'apps/otel-collector/Dockerfile', cache: false },
    command: [
      '--config',
      '/otelcol/collector-config.yaml',
      '--set',
      `service::pipelines::traces::exporters=${input.collectorTraceExporters}`,
      '--set',
      `service::pipelines::metrics::exporters=${input.collectorExporters}`,
      '--set',
      `service::pipelines::logs::exporters=${input.collectorExporters}`,
    ],
    loadBalancer: {
      public: false,
      rules: [
        { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
        { listen: '80/http', forward: `${PORTS.OTEL_HEALTH}/http` },
      ],
      health: {
        [`${PORTS.OTLP_HTTP}/http`]: httpHealth('/', { successCodes: '200-499' }),
        [`${PORTS.OTEL_HEALTH}/http`]: httpHealth('/health/status'),
      },
    },
    environment: {
      CLICKHOUSE_ENDPOINT: input.clickHouseWriterEndpoint || 'https://clickhouse-disabled.invalid:443',
      CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_WRITER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
      CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_WRITER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
      CLICKHOUSE_PASSWORD: input.clickHouseWriterPassword || 'unused',
      CLICKHOUSE_CREATE_SCHEMA: envOr('CLICKHOUSE_CREATE_SCHEMA', 'false'),
      CLICKHOUSE_COMPRESS: envOr('CLICKHOUSE_COMPRESS', 'none'),
      BOXLITE_API_URL: envOr('BOXLITE_API_URL', `https://api.${input.stackDomain}/api`),
      BOXLITE_API_KEY: envOr(
        'BOXLITE_API_KEY',
        envOr('OTEL_COLLECTOR_API_KEY', envOr('ADMIN_API_KEY', input.adminApiKey.result)),
      ),
      JAEGER_OTLP_HTTP_ENDPOINT: jaegerOtlpHttpEndpoint,
    },
  })
  const otelCollectorOtlpHttpUrl = input
    .stripTrailingSlash(otelCollector.url)
    .apply((url) => `${url}:${PORTS.OTLP_HTTP}`)
  return { otelCollectorOtlpHttpUrl }
}
