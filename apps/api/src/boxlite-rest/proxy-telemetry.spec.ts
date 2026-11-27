/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { EventEmitter } from 'node:events'
import { createProxyMiddleware, errorResponsePlugin } from 'http-proxy-middleware'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { startTimedOperation } from '../common/decorators/otel.decorator'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  errorResponsePlugin: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 600_000 })
const meterProvider = new MeterProvider({ readers: [metricReader] })
const spanExporter = new InMemorySpanExporter()
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })

function spans(name: string) {
  return spanExporter.getFinishedSpans().filter((span) => span.name === name)
}

async function histogramPoints(name: string): Promise<any[]> {
  await metricReader.forceFlush()
  return metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric): any[] => metric.dataPoints as any[])
}

function proxyRequest() {
  return Object.assign(new EventEmitter(), { setHeader: jest.fn(), destroy: jest.fn() })
}

function socket() {
  return Object.assign(new EventEmitter(), { write: jest.fn(), destroy: jest.fn() })
}

describe('runner proxy telemetry', () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    metrics.setGlobalMeterProvider(meterProvider)
    trace.setGlobalTracerProvider(tracerProvider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  })
  beforeEach(() => {
    metricExporter.reset()
    spanExporter.reset()
    jest.clearAllMocks()
  })
  afterAll(async () => {
    await meterProvider.shutdown()
    await tracerProvider.shutdown()
    metrics.disable()
    trace.disable()
    propagation.disable()
    context.disable()
  })

  async function httpHarness() {
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)
    const controller = new BoxliteProxyController(
      {
        findOneByIdOrName: jest.fn().mockResolvedValue({
          id: 'box-uuid',
          organizationId: 'org-1',
          runnerId: 'runner-1',
          autoResume: false,
          autoStop: 0,
          state: 'started',
          desiredState: 'started',
        }),
        updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
      } as any,
      { findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }) } as any,
      { ensureReady: jest.fn() } as any,
      {} as any,
    )
    const req = {
      method: 'POST',
      url: '/exec',
      user: { userId: 'user-1', role: 'user', email: 'user@boxlite.dev', apiKey: {}, organizationId: 'org-1' },
      get: () => undefined,
    }
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
      writableFinished: false,
      destroyed: false,
      closed: false,
    })
    await controller.proxyExec(
      { organizationId: 'org-1', organization: { id: 'org-1', suspended: false } } as any,
      'public-box',
      req as any,
      res as any,
      jest.fn(),
    )
    return { options: jest.mocked(createProxyMiddleware).mock.calls[0][0], req, res }
  }

  it('preserves default proxy error responses while recording failures', async () => {
    const { options } = await httpHarness()

    expect(options.plugins).toEqual([errorResponsePlugin])
  })

  it('measures upstream TTFB and the complete response while propagating traceparent', async () => {
    const { options, req, res } = await httpHarness()
    const upstreamReq = proxyRequest()
    options.on!.proxyReq!(upstreamReq as any, req as any, res as any, {} as any)

    const traceparent = upstreamReq.setHeader.mock.calls.find(([name]) => name === 'traceparent')?.[1]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(spans('box.runner_proxy_ttfb')).toHaveLength(0)

    const upstreamRes = Object.assign(new EventEmitter(), { statusCode: 201, readableEnded: false })
    options.on!.proxyRes!(upstreamRes as any, req as any, res as any)
    upstreamRes.emit('data', Buffer.from('{"execution_id":'))
    upstreamRes.emit('data', Buffer.from('"exec-1"}'))
    expect(spans('box.runner_proxy_ttfb')).toHaveLength(1)
    expect(spans('box.runner_proxy_upstream')).toHaveLength(0)

    upstreamRes.readableEnded = true
    upstreamRes.emit('end')
    upstreamRes.emit('close')

    expect(spans('box.runner_proxy_upstream')).toHaveLength(1)
    expect(spans('box.runner_proxy_upstream')[0].attributes.box_id).toBe('box-uuid')
    expect(spans('box.runner_proxy_upstream')[0].attributes['http.status_code']).toBe(201)
    expect(traceparent).toContain(spans('box.runner_proxy_upstream')[0].spanContext().traceId)
    const points = await histogramPoints('box_runner_proxy_upstream_duration')
    expect(points).toHaveLength(1)
    expect(points[0].attributes).toMatchObject({ status: 'success' })
    expect(points[0].attributes).not.toHaveProperty('box_id')
    expect(points[0].attributes).not.toHaveProperty('execution_id')
    expect(await histogramPoints('box_runner_proxy_ttfb_duration')).toHaveLength(1)
    expect(spans('box.exec.http')).toHaveLength(0)
  })

  it.each([
    ['error', 'connection reset'],
    ['timeout', 'socket timeout'],
  ])('records an upstream %s once across terminal callbacks', async (status, message) => {
    const { options, req, res } = await httpHarness()
    const upstreamReq = proxyRequest()
    options.on!.proxyReq!(upstreamReq as any, req as any, res as any, {} as any)
    const error = Object.assign(new Error(message), { code: status === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET' })
    if (status === 'timeout') upstreamReq.emit('timeout')
    options.on!.error!(error, req as any, res as any)
    options.on!.error!(error, req as any, res as any)

    expect(spans('box.runner_proxy_upstream')).toHaveLength(1)
    expect(spans('box.runner_proxy_upstream')[0].status.code).toBe(SpanStatusCode.ERROR)
    const points = await histogramPoints('box_runner_proxy_upstream_duration')
    expect(points).toHaveLength(1)
    expect(points[0].attributes.status).toBe(status)
  })

  function wsHarness(authorized = true) {
    jest.mocked(createProxyMiddleware).mockReturnValue({ upgrade: jest.fn() } as never)
    const service = new BoxliteWsProxyService(
      {
        getApiKeyByValue: jest.fn().mockResolvedValue(
          authorized
            ? {
                organizationId: 'org-1',
                userId: 'user-1',
                expiresAt: null,
                permissions: [OrganizationResourcePermission.WRITE_BOXES],
              }
            : null,
        ),
      } as any,
      { findOne: jest.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' }) } as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'org-1', suspended: false }) } as any,
      {
        findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1', autoResume: false }),
        updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
      } as any,
      { findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }) } as any,
      { ensureReady: jest.fn() } as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'user-1', role: 'user', email: 'dev@acme.test' }) } as any,
      undefined,
      {} as any,
      { createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }), updateLog: jest.fn().mockResolvedValue({}) } as any,
    )
    return { service, options: jest.mocked(createProxyMiddleware).mock.calls[0][0] }
  }

  it('traces the real upgrade, runner handshake and socket lifetime', async () => {
    const { service, options } = wsHarness()
    const clientSocket = socket()
    const req = {
      url: '/api/v1/org-1/boxes/public-box/executions/exec-1/attach',
      headers: { authorization: 'Bearer blk_live_test' },
    }
    await service.upgrade(req as any, clientSocket as any, Buffer.alloc(0))

    expect(spans('box.exec.ws_auth')).toHaveLength(1)
    expect(spans('box.exec.ws_lookup')).toHaveLength(1)
    expect(spans('box.exec.ws')).toHaveLength(0)

    const upstreamReq = proxyRequest()
    options.on!.proxyReqWs!(upstreamReq as any, req as any, clientSocket as any, {} as any, Buffer.alloc(0))
    const traceparent = upstreamReq.setHeader.mock.calls.find(([name]) => name === 'traceparent')?.[1]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)

    const upstreamSocket = socket()
    upstreamReq.emit('upgrade', {}, upstreamSocket, Buffer.alloc(0))
    options.on!.open!(upstreamSocket as any)
    expect(spans('box.exec.ws_handshake')).toHaveLength(1)
    expect(spans('box.exec.ws_handshake')[0].attributes).toMatchObject({
      box_id: 'box-uuid',
      execution_id: 'exec-1',
    })
    expect(traceparent).toContain(spans('box.exec.ws_handshake')[0].spanContext().traceId)

    options.on!.close!({} as any, upstreamSocket as any, Buffer.alloc(0))
    clientSocket.emit('close')
    expect(spans('box.exec.ws')).toHaveLength(1)
    const points = await histogramPoints('box_exec_ws_duration')
    expect(points).toHaveLength(1)
    expect(points[0].attributes).toMatchObject({
      status: 'success',
      component: 'BoxliteWsProxyService',
      method: 'upgrade',
    })
    expect(points[0].attributes).not.toHaveProperty('box_id')
    expect(points[0].attributes).not.toHaveProperty('execution_id')
  })

  it('finishes authentication and the root span on denial', async () => {
    const { service } = wsHarness(false)
    const clientSocket = socket()
    await service.upgrade(
      {
        url: '/api/v1/org-1/boxes/public-box/executions/exec-1/attach',
        headers: { authorization: 'Bearer bad' },
      } as any,
      clientSocket as any,
      Buffer.alloc(0),
    )

    expect(spans('box.exec.ws_auth')[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans('box.exec.ws')).toHaveLength(1)
    expect(spans('box.exec.ws')[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans('box.exec.ws')[0].attributes).toMatchObject({ box_id: 'public-box', execution_id: 'exec-1' })
  })

  it('closes handshake and root spans on a socket error without open or close events', async () => {
    const { service, options } = wsHarness()
    const clientSocket = socket()
    const req = {
      url: '/api/v1/org-1/boxes/public-box/executions/exec-1/attach',
      headers: { authorization: 'Bearer blk_live_test' },
    }
    await service.upgrade(req as any, clientSocket as any, Buffer.alloc(0))
    options.on!.proxyReqWs!(proxyRequest() as any, req as any, clientSocket as any, {} as any, Buffer.alloc(0))

    clientSocket.emit('error', new Error('client vanished'))
    clientSocket.emit('close')

    expect(spans('box.exec.ws_handshake')).toHaveLength(1)
    expect(spans('box.exec.ws_handshake')[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans('box.exec.ws')).toHaveLength(1)
    expect(spans('box.exec.ws')[0].status.code).toBe(SpanStatusCode.ERROR)
  })

  it('marks the root as failed when the runner never completes the upgrade', async () => {
    const { service, options } = wsHarness()
    const clientSocket = socket()
    const req = {
      url: '/api/v1/org-1/boxes/public-box/executions/exec-1/attach',
      headers: { authorization: 'Bearer blk_live_test' },
    }
    await service.upgrade(req as any, clientSocket as any, Buffer.alloc(0))
    options.on!.proxyReqWs!(proxyRequest() as any, req as any, clientSocket as any, {} as any, Buffer.alloc(0))

    clientSocket.emit('close')

    expect(spans('box.exec.ws_handshake')[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans('box.exec.ws')[0].status.code).toBe(SpanStatusCode.ERROR)
  })

  it('uses a monotonic clock for timed operation durations', async () => {
    let wallClock = 5_000
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => wallClock)
    try {
      const operation = startTimedOperation('box.monotonic_test')
      wallClock = 4_000
      operation.finish()
    } finally {
      dateNow.mockRestore()
    }

    const points = await histogramPoints('box_monotonic_test_duration')
    expect(points).toHaveLength(1)
    expect(points[0].value.sum).toBeGreaterThanOrEqual(0)
  })
})
