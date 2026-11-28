/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 BoxLite AI
 */

import { context, metrics, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { DatabaseTelemetry } from './database-telemetry'

const spanExporter = new InMemorySpanExporter()
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })

describe('DatabaseTelemetry', () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    trace.setGlobalTracerProvider(tracerProvider)
  })
  beforeEach(() => {
    spanExporter.reset()
    jest.restoreAllMocks()
  })

  it('reads current PostgreSQL pool occupancy on every collection', () => {
    const callbacks: Array<(observation: { observe(value: number): void }) => void> = []
    const observations: Array<[string, number]> = []
    jest.spyOn(metrics, 'getMeter').mockReturnValue({
      createObservableGauge: () => ({
        addCallback: (callback: (observation: { observe(value: number): void }) => void) => callbacks.push(callback),
      }),
      createHistogram: () => ({ record: jest.fn() }),
    } as any)
    const pool = { totalCount: 10, idleCount: 3, waitingCount: 7, connect: jest.fn() }
    const dataSource = { options: { type: 'postgres' }, driver: { master: pool }, queryResultCache: undefined }

    new DatabaseTelemetry(dataSource as any).onModuleInit()
    pool.totalCount = 11
    pool.idleCount = 2
    pool.waitingCount = 9
    for (const callback of callbacks) callback({ observe: (value) => observations.push(['current', value]) })

    expect(observations.map(([, value]) => value)).toEqual([11, 2, 9])
  })

  it('measures promise and callback connection acquisition without changing their results', async () => {
    const record = jest.fn()
    jest.spyOn(metrics, 'getMeter').mockReturnValue({
      createObservableGauge: () => ({ addCallback: jest.fn() }),
      createHistogram: () => ({ record }),
    } as any)
    const client = { query: jest.fn() }
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      connect(callback?: (error: null, value: typeof client) => void) {
        if (callback) {
          callback(null, client)
          return undefined
        }
        return Promise.resolve(client)
      },
    }
    const telemetry = new DatabaseTelemetry({
      options: { type: 'postgres' },
      driver: { master: pool },
      queryResultCache: undefined,
    } as any)
    telemetry.onModuleInit()

    await expect(pool.connect()).resolves.toBe(client)
    const callbackResult = await new Promise((resolve) => pool.connect((_error, value) => resolve(value)))
    expect(callbackResult).toBe(client)
    expect(record).toHaveBeenCalledTimes(2)
    expect(record.mock.calls.every(([, attributes]) => attributes.status === 'success')).toBe(true)
  })

  it.each([
    ['hit', { time: 1, duration: 60_000, result: [] }, false],
    ['stale', { time: 1, duration: 60_000, result: [] }, true],
    ['miss', undefined, false],
  ])('marks the real TypeORM cache result as %s', async (result, cached, expired) => {
    const cache = {
      getFromCache: jest.fn().mockResolvedValue(cached),
      isExpired: jest.fn().mockReturnValue(expired),
    }
    const dataSource = { options: { type: 'postgres' }, driver: {}, queryResultCache: cache }
    const telemetry = new DatabaseTelemetry(dataSource as any)
    telemetry.onModuleInit()

    const options = { identifier: 'region:60s:not-an-attribute', duration: 60_000 }
    await expect(cache.getFromCache(options as any)).resolves.toBe(cached)

    const spans = spanExporter.getFinishedSpans().filter((span) => span.name === 'typeorm.query_cache_read')
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes).toMatchObject({
      'cache.system': 'typeorm',
      'cache.name': 'region_60s',
      'cache.result': result,
    })
    expect(Object.values(spans[0].attributes)).not.toContain('region:60s:not-an-attribute')
  })

  it('activates the cache-read span for nested Redis instrumentation', async () => {
    let activeSpanId: string | undefined
    const cached = { time: 1, duration: 60_000, result: [] }
    const cache = {
      getFromCache: jest.fn(async () => {
        activeSpanId = trace.getActiveSpan()?.spanContext().spanId
        return cached
      }),
      isExpired: () => false,
    }
    new DatabaseTelemetry({
      options: { type: 'postgres' },
      driver: {},
      queryResultCache: cache,
    } as any).onModuleInit()

    const parent = trace.getTracer('test').startSpan('parent')
    await context.with(trace.setSpan(context.active(), parent), () => (cache.getFromCache as any)({ duration: 1 }))
    parent.end()

    const child = spanExporter.getFinishedSpans().find((span) => span.name === 'typeorm.query_cache_read')
    expect(activeSpanId).toBe(child?.spanContext().spanId)
    expect(child?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  })

  it('preserves cache read errors and marks the span', async () => {
    const failure = new Error('cache unavailable')
    const cache = { getFromCache: jest.fn().mockRejectedValue(failure), isExpired: jest.fn() }
    const telemetry = new DatabaseTelemetry({ options: { type: 'postgres' }, driver: {}, queryResultCache: cache } as any)
    telemetry.onModuleInit()

    await expect(cache.getFromCache({ duration: 1 } as any)).rejects.toBe(failure)

    const span = spanExporter.getFinishedSpans().find((span) => span.name === 'typeorm.query_cache_read')
    expect(span?.status.code).toBe(2)
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true)
  })
})
