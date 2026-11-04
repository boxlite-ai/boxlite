/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { NestFactory } from '@nestjs/core'

jest.mock('./tracing', () => ({ otelSdk: { start: jest.fn() } }))
jest.mock('./app.module', () => ({ AppModule: class {} }))
jest.mock('./ci/ci-listener.service', () => ({ CiListenerService: class {} }))
jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }))
jest.mock('@nestjs/common', () => ({
  Logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ValidationPipe: jest.fn(),
}))
jest.mock('@nestjs/microservices', () => ({ Transport: {} }))
jest.mock('typeorm', () => ({ DataSource: class {}, MigrationExecutor: class {} }))
jest.mock('kafkajs', () => ({ Partitioners: {} }))
jest.mock('nestjs-pino', () => ({ Logger: class {}, LoggerErrorInterceptor: jest.fn() }))
jest.mock('@nestjs/swagger', () => ({
  SwaggerModule: { createDocument: jest.fn(() => ({})), setup: jest.fn() },
}))
jest.mock('node:fs', () => ({ readFileSync: jest.fn(() => '{}') }))
jest.mock('./config/typed-config.service', () => ({ TypedConfigService: class {} }))
jest.mock('./auth/failed-auth-tracker.service', () => ({ FailedAuthTrackerService: class {} }))
jest.mock('./filters/all-exceptions.filter', () => ({ AllExceptionsFilter: jest.fn() }))
jest.mock('./interceptors/metrics.interceptor', () => ({ MetricsInterceptor: jest.fn() }))
jest.mock('./analytics/services/analytics.service', () => ({ AnalyticsService: class {} }))
jest.mock('./audit/interceptors/audit.interceptor', () => ({ AuditInterceptor: class {} }))
jest.mock('./api-key/api-key.service', () => ({ ApiKeyService: class {} }))
jest.mock('./app.service', () => ({ BOXLITE_ADMIN_USER_ID: 'admin' }))
jest.mock('./organization/services/organization.service', () => ({ OrganizationService: class {} }))
jest.mock('./openapi.config', () => ({ getOpenApiConfig: jest.fn(() => ({})) }))
jest.mock('./common/utils/app-mode', () => ({
  isApiEnabled: () => true,
  isWorkerEnabled: () => false,
}))
jest.mock('./boxlite-rest/boxlite-ws-proxy.service', () => ({ BoxliteWsProxyService: class {} }))
jest.mock('./cloud-app/cloud-app.service', () => ({ CloudAppService: class {} }))
jest.mock('./cloud-app/cloud-app-websocket', () => ({ CloudAppWebsocket: class {} }))
jest.mock('./mcp/mcp.controller', () => ({ mcpStrategy: {} }))
jest.mock('./mcp/mcp-auth-metadata', () => ({ MCP_ROOT_ROUTES: [] }))
jest.mock('./mcp/mcp-body', () => ({ useApiBodyParsers: jest.fn() }))
jest.mock('./mcp/mcp-tools', () => ({ McpTools: class {} }))
jest.mock('./mcp/mcp-routes', () => ({ servedOperations: () => [] }))

describe('API bootstrap listener', () => {
  const environment = process.env
  const argv = process.argv

  afterEach(() => {
    process.env = environment
    process.argv = argv
    jest.resetModules()
  })

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['127.0.0.1', '/repo/openapi'],
  ])('binds host=%s with specs=%s and disables request body timeout', async (host, specs) => {
    process.env = { ...environment, OTEL_ENABLED: 'false', CERT_PATH: '', CERT_KEY_PATH: '' }
    delete process.env.BOXLITE_OPENAPI_DIR
    if (specs) process.env.BOXLITE_OPENAPI_DIR = specs
    delete process.env.BOXLITE_LISTEN_HOST
    if (host !== undefined) process.env.BOXLITE_LISTEN_HOST = host
    process.argv = ['node', 'main.js']
    const listen = jest.fn().mockResolvedValue(undefined)
    const httpServer = { on: jest.fn(), requestTimeout: -1 }
    const service = {
      get: (key: string) => (key === 'port' ? 3300 : undefined),
      register: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      matchAttachPath: jest.fn(() => false),
    }
    const app = {
      get: jest.fn(() => service),
      use: jest.fn(),
      useLogger: jest.fn(),
      flushLogs: jest.fn(),
      enableCors: jest.fn(),
      set: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      useGlobalPipes: jest.fn(),
      setGlobalPrefix: jest.fn(),
      enableShutdownHooks: jest.fn(),
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: () => ({ getInstance: () => ({}) }),
      connectMicroservice: () => ({ listen: jest.fn().mockResolvedValue(undefined) }),
      getHttpServer: () => httpServer,
      listen,
    }
    // Reset modules lets each case execute the real bootstrap entry again.
    const factory = require('@nestjs/core').NestFactory as typeof NestFactory
    jest.mocked(factory.create).mockResolvedValue(app as never)
    require('./main')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(listen).toHaveBeenCalledWith(3300, host || '0.0.0.0')
    expect(httpServer.requestTimeout).toBe(0)
    expect(service.start).toHaveBeenCalledTimes(1)
    const { readFileSync } = require('node:fs')
    expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('/openapi/box.openapi.yaml'), 'utf8')
    if (specs) {
      expect(readFileSync).toHaveBeenCalledWith('/repo/openapi/box.openapi.yaml', 'utf8')
      expect(readFileSync).not.toHaveBeenCalledWith(expect.stringContaining('/src/assets/openapi/'), 'utf8')
    } else {
      expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('/assets/openapi/box.openapi.yaml'), 'utf8')
    }
  })
})
