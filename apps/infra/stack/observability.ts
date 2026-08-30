// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import { PORTS, envOr, httpHealth } from './settings.js'
import type { FoundationResources } from './foundation.js'
import {
  CLICKHOUSE_DATABASE,
  CLICKHOUSE_WRITER_USERNAME,
  type ClickHouseResources,
} from './clickhouse.js'

export interface ObservabilityInputs {
  cluster: FoundationResources['cluster']
  stackDomain: string
  adminApiKey: random.RandomPassword
  clickHouseResources: ClickHouseResources
  collectorExporters: string
  stripTrailingSlash: (url: $util.Output<string>) => $util.Output<string>
}

export function buildObservability(input: ObservabilityInputs) {
  const otelCollector = new sst.aws.Service('OtelCollector', {
    cluster: input.cluster,
    wait: input.clickHouseResources.active,
    image: { context: '../..', dockerfile: 'apps/otel-collector/Dockerfile', cache: false },
    command: [
      '--config',
      '/otelcol/collector-config.yaml',
      '--set',
      `service::pipelines::traces::exporters=${input.collectorExporters}`,
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
      ...(input.clickHouseResources.mode !== 'disabled'
        ? { CLICKHOUSE_PASSWORD: input.clickHouseResources.writerSecretArn }
        : {}),
    },
    environment: {
      CLICKHOUSE_ENDPOINT:
        input.clickHouseResources.mode !== 'disabled'
          ? input.clickHouseResources.url
          : 'https://clickhouse-disabled.invalid:443',
      CLICKHOUSE_DATABASE,
      CLICKHOUSE_USERNAME: CLICKHOUSE_WRITER_USERNAME,
      ...(input.clickHouseResources.mode !== 'disabled'
        ? { CLICKHOUSE_CREDENTIAL_VERSION: input.clickHouseResources.writerSecretVersionId }
        : {}),
      CLICKHOUSE_CREATE_SCHEMA: 'false',
      CLICKHOUSE_COMPRESS: 'none',
      BOXLITE_API_URL: envOr('BOXLITE_API_URL', `https://api.${input.stackDomain}/api`),
      BOXLITE_API_KEY: envOr(
        'BOXLITE_API_KEY',
        envOr('OTEL_COLLECTOR_API_KEY', envOr('ADMIN_API_KEY', input.adminApiKey.result)),
      ),
    },
    transform: {
      loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
    },
  }, {
    dependsOn: [
      ...(input.clickHouseResources.mode === 'self-hosted' ? [input.clickHouseResources.ready] : []),
    ],
  })
  const otelCollectorOtlpHttpUrl = input
    .stripTrailingSlash(otelCollector.url)
    .apply((url) => `${url}:${PORTS.OTLP_HTTP}`)
  return { otelCollector, otelCollectorOtlpHttpUrl }
}
