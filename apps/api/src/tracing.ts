/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_INSTANCE_ID,
} from '@opentelemetry/semantic-conventions/incubating'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs'
import { getAppMode } from './common/utils/app-mode'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { hostname } from 'os'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'

// Enable OpenTelemetry diagnostics
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

const appMode = getAppMode()
const serviceNameSuffix = appMode === 'api' ? 'api' : appMode === 'worker' ? 'worker' : 'api'

// sdk-node@^0.218 brings otlp-exporter-base@0.218 to the hoisted root,
// but exporter-{trace,metrics,logs}-otlp-http are still pinned at ^0.207
// and carry their own nested 0.207 copy. The two carry incompatible
// `headers` typings. Cast at the call sites below until the http exporters
// catch up to 0.218 in a follow-up dep-bump PR.
const otlpExporterConfig: OTLPExporterNodeConfigBase = {
  compression: CompressionAlgorithm.GZIP,
  keepAlive: true,
}

const otelSdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: `boxlite-${serviceNameSuffix}`,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.ENVIRONMENT,
    [ATTR_SERVICE_INSTANCE_ID]: process.env.NODE_APP_INSTANCE
      ? `${hostname()}-${process.env.NODE_APP_INSTANCE}`
      : hostname(),
  }),
  instrumentations: [
    new PinoInstrumentation(),
    new HttpInstrumentation({ requireParentforOutgoingSpans: true }),
    new ExpressInstrumentation(),
    new NestInstrumentation(),
    new IORedisInstrumentation({ requireParentSpan: true }),
    new PgInstrumentation({ requireParentSpan: true }),
    new KafkaJsInstrumentation(),
    new RuntimeNodeInstrumentation(),
  ],
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter(otlpExporterConfig as any))],
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(otlpExporterConfig as any))],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(otlpExporterConfig as any),
      exportIntervalMillis: 30 * 1000,
    }),
  ],
})

export { otelSdk }

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down OpenTelemetry SDK')
  await otelSdk.shutdown()
  console.log('OpenTelemetry SDK shut down')
})
