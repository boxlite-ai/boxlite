/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { EventEmitter } from 'node:events'
import { Context } from '../context/context'
import { BoxService } from '../../box/services/box.service'
import { BoxliteBoxController } from '../../boxlite-rest/boxlite-box.controller'
import { RunnerService } from '../../box/services/runner.service'
import { Singleflight } from '../utils/singleflight.util'
import { TtlLruCache } from '../utils/ttl-lru-cache.util'
import { ImageAdmissionService } from '../../image/services/image-admission.service'
import { ImageResolverService } from '../../image/services/image-resolver.service'
import { BoxStateWaiterService } from '../../box/services/box-state-waiter.service'
import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_EVENT_CHANNEL } from '../constants/constants'
import { NotificationService } from '../../notification/services/notification.service'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { JobService } from '../../box/services/job.service'
import { JobType } from '../../box/enums/job-type.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { BoxliteProxyController } from '../../boxlite-rest/boxlite-proxy.controller'
import { BoxAutoResumeService } from '../../box/services/box-auto-resume.service'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { AuditService } from '../../audit/services/audit.service'
import { withResponseInstrumentation } from './otel.decorator'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 600_000 })
const meterProvider = new MeterProvider({ readers: [metricReader] })
const spanExporter = new InMemorySpanExporter()
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })

async function histogramNames(): Promise<string[]> {
  await metricReader.forceFlush()
  return metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .map((metric) => metric.descriptor.name)
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

function finishedSpans() {
  return spanExporter.getFinishedSpans()
}

function expectSpanParent(childName: string, parentName: string): void {
  const child = finishedSpans().find((span) => span.name === childName)
  const parent = finishedSpans().find((span) => span.name === parentName)
  expect(child).toBeDefined()
  expect(parent).toBeDefined()
  expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId)
  expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId)
}

describe('API timing trace relationships', () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    metrics.setGlobalMeterProvider(meterProvider)
    trace.setGlobalTracerProvider(tracerProvider)
  })
  beforeEach(() => {
    metricExporter.reset()
    spanExporter.reset()
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await meterProvider.shutdown()
    await tracerProvider.shutdown()
    metrics.disable()
    trace.disable()
    context.disable()
  })

  it('nests create orchestration and runner selection under their callers', async () => {
    const runnerService = {
      findAvailableRunners: async () => [{ id: 'runner-1' }],
      getRandomAvailableRunner: RunnerService.prototype.getRandomAvailableRunner,
    }
    const service = {
      organizationService: {
        isNestedVirtualizationEnabled: async () => false,
        assertOrganizationIsNotSuspended: () => undefined,
      },
      getValidatedOrDefaultRegion: async () => ({ id: 'us' }),
      getValidatedOrDefaultClass: () => 'small',
      organizationBoxLimits: {
        resolve: async () => ({ maxCpuPerBox: 100, maxMemoryPerBox: 100, maxDiskPerBox: 1000 }),
      },
      imageAdmissionService: {
        assert: ImageAdmissionService.prototype.assert,
        spendColdPullBudget: async () => undefined,
      },
      imageResolverService: { resolve: ImageResolverService.prototype.resolve },
      redis: { exists: async () => 1 },
      secretServerClient: { storeBoxSecrets: async () => [] },
      resolveLifecyclePolicy: () => ({ autoStop: 0, autoDelete: 0, autoResume: false }),
      runnerService,
      persistOnAvailableRunner: (BoxService.prototype as any).persistOnAvailableRunner,
      boxRepository: { insert: async (box) => box },
      eventEmitter: { emitAsync: async () => [] },
      toBoxDto: async (box) => ({ ...box, state: BoxState.STARTED }),
      create: BoxService.prototype.create,
    }
    const controller = new BoxliteBoxController(
      service as any,
      {} as any,
      { resolveMaxCreatedBoxes: async () => undefined } as any,
      {} as any,
    )

    await controller.createBox(
      {
        organizationId: 'org-1',
        organization: { id: 'org-1', boxLimitedNetworkEgress: false },
        userId: 'user-1',
      } as any,
      { name: 'timing-test', image: 'base' } as any,
      Context.user(),
    )

    await expect(histogramNames()).resolves.toContain('box_create_http_duration')
    expectSpanParent('box.service_create', 'box.create_http')
    expectSpanParent('image.admission', 'box.service_create')
    expectSpanParent('image.resolve', 'box.service_create')
    expectSpanParent('box.persist_available_runner', 'box.service_create')
    expectSpanParent('box.runner_select', 'box.persist_available_runner')
  })

  it('keeps waiter, notification and job children attached to their operations', async () => {
    const subscriber = new EventEmitter() as any
    subscriber.subscribe = jest.fn().mockResolvedValue(1)
    const waiter = new BoxStateWaiterService(
      {
        findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1', state: BoxState.STARTING }),
        toBoxDto: jest.fn(async (box) => box),
      } as any,
      { duplicate: () => subscriber } as any,
    )
    const waiting = waiter.waitForStarted('box-1', 'org-1', 5)
    await new Promise((resolve) => setImmediate(resolve))
    subscriber.emit('message', BOX_EVENT_CHANNEL, JSON.stringify({ box: { id: 'box-1', state: BoxState.STARTED } }))
    await waiting

    expectSpanParent('box.state_subscription', 'box.state_wait')
    expectSpanParent('box.state_wait_dto', 'box.state_wait')

    const notification = new NotificationService(
      { emitBoxStateUpdated: jest.fn() } as any,
      {} as any,
      { toBoxDto: jest.fn(async (box) => box) } as any,
      { publish: jest.fn().mockResolvedValue(1) } as any,
    )
    await notification.handleBoxStateUpdated(
      new BoxStateUpdatedEvent({ id: 'box-1' } as any, BoxState.CREATING, BoxState.STARTED),
    )
    await new Promise(setImmediate)

    expectSpanParent('box.state_notification_dto', 'box.state_notification')
    expectSpanParent('box.state_notification_publish', 'box.state_notification')

    const jobs = new JobService(
      { insert: jest.fn().mockResolvedValue(undefined) } as any,
      { lpush: jest.fn().mockResolvedValue(1) } as any,
      {} as any,
    )
    await jobs.createJob(null, JobType.CREATE_BOX, 'runner-1', ResourceType.BOX, 'box-1', { image: 'base' })
    expectSpanParent('box.job_notify', 'box.job_create')
  })

  it('keeps timeout DTO enrichment under the original wait span', async () => {
    jest.useFakeTimers()
    try {
      const subscriber = new EventEmitter() as any
      subscriber.subscribe = jest.fn().mockResolvedValue(1)
      const waiter = new BoxStateWaiterService(
        {
          findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1', state: BoxState.CREATING }),
          toBoxDto: jest.fn(async (box) => box),
        } as any,
        { duplicate: () => subscriber } as any,
      )
      const waiting = expect(waiter.waitForStarted('box-1', 'org-1', 1)).rejects.toThrow(
        'Timed out waiting for box box-1 to reach started',
      )
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(1000)
      await waiting

      expectSpanParent('box.state_wait_dto', 'box.state_wait')
    } finally {
      jest.useRealTimers()
    }
  })

  it('measures exec setup separately from the response and preserves parentage', async () => {
    const box = {
      id: 'box-1',
      organizationId: 'org-1',
      runnerId: 'runner-1',
      autoResume: true,
      autoStop: 0,
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      inboundEnabled: true,
    }
    const startedBox = { ...box, state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED }
    const boxService = {
      boxRepository: {
        findOne: jest.fn().mockResolvedValue(box),
        conditionalStartForProxy: jest.fn().mockResolvedValue(startedBox),
      },
      boxActivityService: { updateLastActivityAt: jest.fn().mockResolvedValue(undefined) },
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      eventEmitter: { emit: jest.fn() },
      findOneByIdOrName: BoxService.prototype.findOneByIdOrName,
      updateLastActivityAt: BoxService.prototype.updateLastActivityAt,
      ensureStartedForProxy: BoxService.prototype.ensureStartedForProxy,
      assertOrganizationIsNotSuspended: BoxService.prototype.assertOrganizationIsNotSuspended,
    }
    const autoResume = Object.assign(Object.create(BoxAutoResumeService.prototype), {
      boxService,
      boxStateWaiter: {},
      redisLockProvider: { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) },
    })
    const runnerService = Object.assign(Object.create(RunnerService.prototype), {
      lookupSingleflight: new Singleflight(),
      proxyTargetCache: new TtlLruCache(10, 60_000),
      runnerRepository: {
        findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }),
      },
    })
    const controller = new BoxliteProxyController(boxService as any, runnerService, autoResume, {} as any)
    const req = {
      method: 'POST',
      url: '/exec',
      user: { userId: 'user-1', role: 'user', email: 'user@boxlite.dev', apiKey: {}, organizationId: 'org-1' },
      get: () => undefined,
    }
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
      closed: false,
    })

    await controller.proxyExec(
      { organizationId: 'org-1', organization: { id: 'org-1', suspended: false } } as any,
      'box-1',
      req as any,
      res as any,
      jest.fn(),
    )

    const beforeFinish = await histogramNames()
    expect(beforeFinish).not.toContain('box_exec_http_duration')
    expect(finishedSpans().some((span) => span.name === 'box.exec.http')).toBe(false)

    res.emit('finish')
    await new Promise(setImmediate)

    await expect(histogramNames()).resolves.toEqual(
      expect.arrayContaining([
        'box_exec_http_duration',
        'box_runner_proxy_setup_duration',
        'box_exec_http_duration',
        'box_lookup_duration',
        'box_activity_update_duration',
        'box_auto_resume_duration',
        'box_auto_resume_start_duration',
        'box_proxy_start_duration',
        'box_runner_lookup_duration',
      ]),
    )
    expect(finishedSpans().find((span) => span.name === 'box.exec.http')?.parentSpanContext).toBeUndefined()
    expectSpanParent('box.runner_proxy_setup', 'box.exec.http')
    expectSpanParent('box.activity_update', 'box.runner_proxy_setup')
    expectSpanParent('box.auto_resume', 'box.runner_proxy_setup')
    expectSpanParent('box.auto_resume_start', 'box.auto_resume')
    expectSpanParent('box.proxy_start', 'box.auto_resume_start')
    expectSpanParent('box.runner_lookup', 'box.runner_proxy_setup')
    expect(finishedSpans().find((span) => span.name === 'box.lookup')?.parentSpanContext?.spanId).toBe(
      finishedSpans()
        .find((span) => span.name === 'box.runner_proxy_setup')
        ?.spanContext().spanId,
    )
  })

  it('records response audit lease acquisition and completion writes', async () => {
    const query = jest.fn().mockResolvedValue([[{ id: 'audit' }], 1])
    const service = new AuditService({} as never, { get: () => false } as never, {} as never, {} as never, {} as never)
    jest
      .spyOn(service as any, 'writeWithDeadline')
      .mockImplementation(async (_deadline, operation: any) => operation({ query }))

    const lease = await service.keepPendingLogAlive('audit')
    await lease.complete({ statusCode: 200 })

    await expect(histogramNames()).resolves.toEqual(
      expect.arrayContaining(['audit_pending_lease_duration', 'audit_pending_lease_complete_duration']),
    )
  })

  it('closes exec timing once with an error when the client disconnects', async () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
      closed: false,
    })

    await expect(withResponseInstrumentation('box.exec.http', response as any, async () => 'accepted')).resolves.toBe(
      'accepted',
    )
    response.emit('close')
    response.emit('finish')
    await new Promise(setImmediate)

    const points = await histogramPoints('box_exec_http_duration')
    expect(points).toHaveLength(1)
    expect(points[0].attributes.status).toBe('error')
    expect(finishedSpans().find((span) => span.name === 'box.exec.http')?.status.code).toBe(SpanStatusCode.ERROR)
  })

  it('ends exec timing and removes listeners when proxy setup rejects', async () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
      closed: false,
    })

    await expect(
      withResponseInstrumentation('box.exec.http', response as any, async () => {
        throw new Error('start failed')
      }),
    ).rejects.toThrow('start failed')

    const points = await histogramPoints('box_exec_http_duration')
    expect(points).toHaveLength(1)
    expect(points[0].attributes.status).toBe('error')
    expect(response.listenerCount('finish')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })
})
