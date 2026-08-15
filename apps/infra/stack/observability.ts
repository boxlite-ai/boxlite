// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import { IMAGES, PORTS, envOr, httpHealth } from './settings.js'
import type { FoundationResources } from './foundation.js'
import type { ClickHouseResources } from './clickhouse.js'
import type { ClickHouseConfig } from '../scripts/clickhouse-config.mjs'

export interface ObservabilityInputs {
  cluster: FoundationResources['cluster']
  stackDomain: string
  adminApiKey: random.RandomPassword
  clickHouseConfig: ClickHouseConfig
  clickHouseResources: ClickHouseResources
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
    transform: {
      loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
    },
  })
  const jaegerOtlpHttpEndpoint = input
    .stripTrailingSlash(jaeger.url)
    .apply((url) => `${url}:${PORTS.OTLP_HTTP}`)

  const otelCollector = new sst.aws.Service('OtelCollector', {
    cluster: input.cluster,
    wait: input.clickHouseConfig.active,
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
    ssm: {
      ...(input.clickHouseConfig.active && input.clickHouseResources.writerSecretArn
        ? { CLICKHOUSE_PASSWORD: input.clickHouseResources.writerSecretArn }
        : {}),
    },
    environment: {
      CLICKHOUSE_ENDPOINT:
        input.clickHouseConfig.active && input.clickHouseResources.url
          ? input.clickHouseResources.url
          : 'https://clickhouse-disabled.invalid:443',
      CLICKHOUSE_DATABASE: input.clickHouseConfig.database || 'otel',
      CLICKHOUSE_USERNAME:
        input.clickHouseConfig.writerUsername || 'otel_writer',
      CLICKHOUSE_CREATE_SCHEMA: 'false',
      CLICKHOUSE_COMPRESS: 'none',
      BOXLITE_API_URL: envOr('BOXLITE_API_URL', `https://api.${input.stackDomain}/api`),
      BOXLITE_API_KEY: envOr(
        'BOXLITE_API_KEY',
        envOr('OTEL_COLLECTOR_API_KEY', envOr('ADMIN_API_KEY', input.adminApiKey.result)),
      ),
      JAEGER_OTLP_HTTP_ENDPOINT: jaegerOtlpHttpEndpoint,
    },
    transform: {
      loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
    },
  }, {
    dependsOn: [
      ...(input.clickHouseResources.ready ? [input.clickHouseResources.ready] : []),
    ],
  })
  const otelCollectorOtlpHttpUrl = input
    .stripTrailingSlash(otelCollector.url)
    .apply((url) => `${url}:${PORTS.OTLP_HTTP}`)
  return { otelCollector, otelCollectorOtlpHttpUrl }
}
