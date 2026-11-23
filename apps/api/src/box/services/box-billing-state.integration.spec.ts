/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { ScheduleModule } from '@nestjs/schedule'
import { Test, TestingModule } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import Redis from 'ioredis'
import { DataSource, Repository } from 'typeorm'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { TypedConfigService } from '../../config/typed-config.service'
import { usageExportConfig } from '../../config/configuration'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationService } from '../../organization/services/organization.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxEvents } from '../constants/box-events.constants'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxStoppedEvent } from '../events/box-stopped.event'
import { BoxRepository } from '../repositories/box.repository'
import { BoxBillingStateService } from './box-billing-state.service'
import { BoxService } from './box.service'

const describeIfServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip
const schemaName = `billing_state_${process.pid}_${randomUUID().replaceAll('-', '')}`
const testToken = 'billing-state-integration-token'
const organizationId = randomUUID()
const region = 'billing-test'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

describeIfServices('Commerce billing-state acceptance (real Postgres, Redis and HTTP)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let repository: BoxRepository
  let redis: Redis
  let server: Server
  let baseUrl: string
  let ownsSchema = false
  let boxService: BoxService
  let events: EventEmitter2
  let worker: BoxBillingStateService
  let config: TypedConfigService
  let log: jest.SpyInstance
  let module: TestingModule | undefined
  const stopped: BoxStoppedEvent[] = []
  const requests: { path: string; authorization: string | undefined }[] = []
  const states = new Map<string, string>()
  const lockKeys = new Set<string>()
  let responseStatus = 200
  let responsePath = '/internal/billing-states'
  let responseOverride: unknown
  let requestGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined

  function locks(): RedisLockProvider {
    const provider = new RedisLockProvider(redis)
    const acquire = provider.acquireLease.bind(provider)
    jest.spyOn(provider, 'acquireLease').mockImplementation((key, ttl, signal) => {
      const isolated = `${schemaName}:${key}`
      lockKeys.add(isolated)
      return acquire(isolated, ttl, signal)
    })
    return provider
  }

  async function runningBox(owner = organizationId): Promise<Box> {
    const box = new Box(region)
    box.organizationId = owner
    box.osUser = 'boxlite'
    box.state = BoxState.STARTED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = false
    await boxes.insert(box)
    return box
  }

  async function expectStopIntent(box: Box): Promise<void> {
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      organizationId: box.organizationId,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STOPPED,
      pending: true,
    })
    expect(stopped.some((event) => event.box.id === box.id)).toBe(true)
  }

  async function blockedBy(blockerPid: number): Promise<number | undefined> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const waiting: { pid: number }[] = await dataSource.query(
        `SELECT pid FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND state = 'active'`,
        [blockerPid],
      )
      if (waiting.length > 0) return waiting[0].pid
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    return undefined
  }

  // Runner completion is outside this suite's Stop-intent acceptance boundary.
  async function finishStopAndRestart(box: Box): Promise<void> {
    await boxes.update(box.id, { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false })
    const started = await boxService.start(
      box.id,
      { id: box.organizationId, suspended: false } as Organization,
      Context.user(),
    )
    expect(started).toMatchObject({ desiredState: BoxDesiredState.STARTED, pending: true })
    await boxes.update(box.id, { state: BoxState.STARTED, pending: false })
  }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
    })
    await redis.connect()

    events = new EventEmitter2()
    events.on(BoxEvents.STOPPED, (event: BoxStoppedEvent) => stopped.push(event))
    repository = new BoxRepository(dataSource, events, { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never)
    boxService = Object.create(BoxService.prototype) as BoxService
    Object.assign(boxService, {
      boxRepository: repository,
      eventEmitter: events,
      regionService: { findOne: jest.fn().mockResolvedValue({ id: region }) },
      organizationService: Object.create(OrganizationService.prototype),
    })

    server = createServer((request, response) => {
      void (async () => {
        const path = request.url || ''
        requests.push({ path, authorization: request.headers.authorization })
        if (requestGate) {
          requestGate.entered.resolve()
          await requestGate.release.promise
        }
        response.statusCode = path === responsePath ? responseStatus : 404
        response.setHeader('content-type', 'application/json')
        const evaluatedAt = new Date().toISOString()
        response.end(
          JSON.stringify(
            responseOverride ??
              Array.from(states, ([organizationId, billingState]) => ({
                organizationId,
                billingState,
                evaluatedAt,
                ...(billingState === 'ERROR' ? { errorCode: 'SETTLEMENT_HALTED' } : {}),
              })),
          ),
        )
      })().catch(() => response.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    const settings: Record<string, string> = {
      billingApiUrl: baseUrl,
      'usageExport.url': new URL(baseUrl).origin,
      'usageExport.token': testToken,
    }
    config = {
      get: (key: string) => settings[key],
    } as TypedConfigService
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation()
  }, 30_000)

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    stopped.length = 0
    requests.length = 0
    states.clear()
    responseStatus = 200
    responsePath = '/internal/billing-states'
    responseOverride = undefined
    requestGate = undefined
    log.mockClear()
    worker = new BoxBillingStateService(config, repository, boxService, locks())
  })

  afterEach(async () => {
    requestGate?.release.resolve()
    await module?.close()
    module = undefined
    await worker?.beforeApplicationShutdown()
    if (lockKeys.size) await redis.del(...lockKeys, ...Array.from(lockKeys, (key) => `{${key}}:checkpoint`))
    lockKeys.clear()
  })

  afterAll(async () => {
    log?.mockRestore()
    redis?.disconnect()
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (dataSource?.isInitialized) {
      try {
        if (ownsSchema) await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`)
      } finally {
        await dataSource.destroy()
      }
    }
  })

  it.each(['POSITIVE', 'ZERO'])('A1: %s preserves Running Boxes and user stop/start', async (state) => {
    states.set(organizationId, state)
    const box = await runningBox()
    await worker.reconcile()
    expect(stopped).toHaveLength(0)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
    await boxService.stop(box.id, organizationId, Context.user())
    await expectStopIntent(box)
    await finishStopAndRestart(box)
    await worker.reconcile()
    expect(stopped).toHaveLength(1)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
  })

  it('A2: the registered scheduler submits Stop intents for 30 Running Boxes within five minutes', async () => {
    const targets = await Promise.all(
      Array.from({ length: 30 }, () => {
        const owner = randomUUID()
        states.set(owner, 'NEGATIVE')
        return runningBox(owner)
      }),
    )
    const ordinary = await runningBox()
    const warm = await runningBox(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    const complete = deferred()
    const onStopped = () => {
      if (stopped.length === targets.length) complete.resolve()
    }
    events.on(BoxEvents.STOPPED, onStopped)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const began = Date.now()
    try {
      module = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          BoxBillingStateService,
          { provide: TypedConfigService, useValue: config },
          { provide: BoxRepository, useValue: repository },
          // Expose the real stop method without registering BoxService's unrelated crons.
          { provide: BoxService, useValue: { stop: boxService.stop.bind(boxService) } },
          { provide: RedisLockProvider, useValue: locks() },
        ],
      }).compile()
      await module.init()
      await Promise.race([
        complete.promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Scheduled billing-state stop did not complete in 45 seconds')),
            45_000,
          )
        }),
      ])
      expect(Date.now() - began).toBeLessThan(300_000)
      await Promise.all(targets.map(expectStopIntent))
      for (const box of [ordinary, warm]) {
        expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
          desiredState: BoxDesiredState.STARTED,
          pending: false,
        })
      }
      expect(requests).toEqual([{ path: '/internal/billing-states', authorization: `Bearer ${testToken}` }])
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              event: 'billing_stop_accepted',
              organizationId: targets[0].organizationId,
              boxId: targets[0].id,
              billingState: 'NEGATIVE',
              evaluatedAt: expect.any(String),
              observedAt: expect.any(String),
            }),
          ]),
        ]),
      )
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            'box.stop requested',
            expect.objectContaining({ 'actor.kind': 'platform', 'event.reason': 'billing_negative' }),
          ]),
        ]),
      )
    } finally {
      clearTimeout(timeout)
      events.off(BoxEvents.STOPPED, onStopped)
    }
  }, 60_000)

  it.each(['POSITIVE', 'ZERO'])('A3: recovery to %s allows restart without another automatic stop', async (state) => {
    const box = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    await worker.reconcile()
    await expectStopIntent(box)
    states.set(organizationId, state)
    await finishStopAndRestart(box)
    await worker.reconcile()
    expect(stopped).toHaveLength(1)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
  })

  it.each(['POSITIVE', 'ZERO'])(
    'stops submitting intents after the snapshot window expires and reads %s on the next run',
    async (state) => {
      const candidates = []
      for (let index = 0; index < 3; index++) {
        const box = await runningBox()
        await boxes.update(box.id, { createdAt: new Date(index * 1_000) })
        candidates.push(box)
      }
      const [first, ...remaining] = candidates
      states.set(organizationId, 'NEGATIVE')
      const find = jest.spyOn(repository, 'findRunningForStop')
      const realNow = Date.now
      let offsetMs = 0
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs)
      const completed = deferred()
      const release = deferred()
      const stop = boxService.stop.bind(boxService)
      const gatedStop = jest.spyOn(boxService, 'stop').mockImplementationOnce(async (...args) => {
        const result = await stop(...args)
        completed.resolve()
        await release.promise
        return result
      })
      let run: Promise<void> | undefined

      try {
        run = worker.reconcile()
        await completed.promise
        expect(requests).toHaveLength(1)
        await expectStopIntent(first)

        states.set(organizationId, state)
        offsetMs = 30_001
        release.resolve()
        await run

        await expectStopIntent(first)
        expect(stopped.map((event) => event.box.id)).toEqual([first.id])
        for (const box of remaining) {
          expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
            state: BoxState.STARTED,
            desiredState: BoxDesiredState.STARTED,
            pending: false,
          })
        }
        expect(requests).toHaveLength(1)

        offsetMs = 0
        await worker.reconcile()

        expect(stopped.map((event) => event.box.id)).toEqual([first.id])
        for (const box of remaining) {
          expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
            state: BoxState.STARTED,
            desiredState: BoxDesiredState.STARTED,
            pending: false,
          })
        }
        expect(requests).toHaveLength(2)
        expect(requests.every((request) => request.path === '/internal/billing-states')).toBe(true)
      } finally {
        try {
          release.resolve()
          await run
        } finally {
          clock.mockRestore()
          find.mockRestore()
          gatedStop.mockRestore()
        }
      }
    },
    20_000,
  )

  it('bounds a contended background stop, continues other organizations and preserves user lock waits', async () => {
    const first = await runningBox()
    const other = await runningBox(randomUUID())
    await boxes.update(first.id, { createdAt: new Date(Date.now() - 60_000) })
    states.set(first.organizationId, 'NEGATIVE')
    states.set(other.organizationId, 'NEGATIVE')
    const blocker = dataSource.createQueryRunner()
    const operation = dataSource.createQueryRunner()
    let run: Promise<void> | undefined
    let userStop: Promise<Box> | undefined
    let manager: jest.SpyInstance | undefined

    try {
      await blocker.connect()
      await operation.connect()
      const [{ pid: blockerPid }] = await blocker.query('SELECT pg_backend_pid()::int AS pid')
      const [{ pid: operationPid }] = await operation.query('SELECT pg_backend_pid()::int AS pid')
      const timeoutBefore = await operation.query('SHOW lock_timeout')
      // Reuse this connection for background and user transactions to detect leaked settings.
      manager = jest.spyOn(repository, 'manager', 'get').mockReturnValue(operation.manager)
      await blocker.startTransaction()
      await blocker.manager.findOneOrFail(Box, {
        where: { id: first.id },
        lock: { mode: 'pessimistic_write' },
      })

      run = worker.reconcile()
      expect(await blockedBy(blockerPid)).toBe(operationPid)
      expect(await settlesWithin(run, 2_000)).toBe(true)

      expect(blocker.isTransactionActive).toBe(true)
      expect(operation.isTransactionActive).toBe(false)
      expect(await operation.query('SHOW lock_timeout')).toEqual(timeoutBefore)
      await expectStopIntent(other)
      expect(stopped.map((event) => event.box.id)).toEqual([other.id])
      expect(await boxes.findOneByOrFail({ id: first.id })).toMatchObject({
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ event: 'billing_poll_completed', failureCount: 1, stopAcceptedCount: 1 })],
        ]),
      )

      await blocker.rollbackTransaction()
      expect(await boxes.findOneByOrFail({ id: first.id })).toMatchObject({
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
      expect(stopped.map((event) => event.box.id)).toEqual([other.id])
      await worker.reconcile()
      await expectStopIntent(first)
      expect(stopped.map((event) => event.box.id)).toEqual([other.id, first.id])

      const ordinary = await runningBox(randomUUID())
      await blocker.startTransaction()
      await blocker.manager.findOneOrFail(Box, {
        where: { id: ordinary.id },
        lock: { mode: 'pessimistic_write' },
      })
      userStop = boxService.stop(ordinary.id, ordinary.organizationId, Context.user())
      expect(await blockedBy(blockerPid)).toBe(operationPid)
      expect(await settlesWithin(userStop, 750)).toBe(false)
      await blocker.rollbackTransaction()
      await userStop
      await expectStopIntent(ordinary)
      expect(await operation.query('SHOW lock_timeout')).toEqual(timeoutBefore)
    } finally {
      try {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await Promise.all([run, userStop])
      } finally {
        manager?.mockRestore()
        await operation.release()
        await blocker.release()
      }
    }
  }, 20_000)

  it.each([false, true])(
    'bounds the Stop lookup after a table lock arrives (shutdown=%s)',
    async (shutdown) => {
      const box = await runningBox()
      states.set(organizationId, 'NEGATIVE')
      const blocker = dataSource.createQueryRunner()
      const readCandidates = repository.findRunningForStop.bind(repository)
      let blockerPid: number
      const find = jest.spyOn(repository, 'findRunningForStop').mockImplementationOnce(async (...args) => {
        const candidates = await readCandidates(...args)
        await blocker.query(`LOCK TABLE "${schemaName}"."box" IN ACCESS EXCLUSIVE MODE`)
        return candidates
      })
      let run: Promise<void> | undefined
      let closing: Promise<void> | undefined
      try {
        await blocker.connect()
        await blocker.startTransaction()
        ;[{ pid: blockerPid }] = await blocker.query('SELECT pg_backend_pid()::int AS pid')
        run = worker.reconcile()
        expect(await blockedBy(blockerPid)).toEqual(expect.any(Number))
        if (shutdown) closing = worker.beforeApplicationShutdown()

        expect(await settlesWithin(closing ?? run, 2_000)).toBe(true)
        expect(blocker.isTransactionActive).toBe(true)
        expect(stopped).toHaveLength(0)
        expect(await redis.exists(...lockKeys)).toBe(0)
        await blocker.rollbackTransaction()
        expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false })
        worker = new BoxBillingStateService(config, repository, boxService, locks())
        await worker.reconcile()
        await expectStopIntent(box)
      } finally {
        const ending = worker.beforeApplicationShutdown()
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await Promise.all([run, closing, ending])
        find.mockRestore()
        await blocker.release()
      }
    },
    20_000,
  )

  it('rejects a Stop when the organization changes between lookup and the locked update', async () => {
    const box = await runningBox()
    const nextOrganization = randomUUID()
    states.set(organizationId, 'NEGATIVE')
    states.set(nextOrganization, 'POSITIVE')
    const entered = deferred()
    const release = deferred()
    const updateWhere = repository.updateWhere.bind(repository)
    const update = jest.spyOn(repository, 'updateWhere').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return updateWhere(...args)
    })
    const run = worker.reconcile()
    try {
      await entered.promise
      await repository.update(box.id, { updateData: { organizationId: nextOrganization, createdAt: new Date() } })
      release.resolve()
      await run

      expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
        organizationId: nextOrganization,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
      expect(stopped).toHaveLength(0)
    } finally {
      release.resolve()
      await run
      update.mockRestore()
    }
  })

  it('preserves name fallback for a bounded Stop lookup', async () => {
    const box = await runningBox()
    await boxes.update(box.id, { name: 'named-stop' })

    await boxService.stop(
      'named-stop',
      organizationId,
      Context.platform(PlatformReason.BILLING_NEGATIVE, { lockTimeoutMs: 500 }),
    )

    await expectStopIntent(box)
  })

  it('routes the snapshot through a separate internal HTTP address and path prefix', async () => {
    const publicRequests: string[] = []
    const publicServer = createServer((request, response) => {
      publicRequests.push(request.url || '')
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve))
    try {
      const publicUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}/api/billing`
      const internal = usageExportConfig({
        BILLING_API_URL: publicUrl,
        USAGE_EXPORT_URL: `${new URL(baseUrl).origin}/gateway`,
        USAGE_EXPORT_TOKEN: testToken,
      })
      const settings = {
        billingApiUrl: publicUrl,
        'usageExport.url': internal.url,
        'usageExport.token': internal.token,
      }
      worker = new BoxBillingStateService(
        { get: (key: keyof typeof settings) => settings[key] } as TypedConfigService,
        repository,
        boxService,
        locks(),
      )
      responsePath = '/gateway/internal/billing-states'
      states.set(organizationId, 'NEGATIVE')
      const box = await runningBox()

      await worker.reconcile()

      await expectStopIntent(box)
      expect(publicRequests).toEqual([])
      expect(requests).toEqual([{ path: responsePath, authorization: `Bearer ${testToken}` }])
    } finally {
      await worker.beforeApplicationShutdown()
      await new Promise<void>((resolve) => publicServer.close(() => resolve()))
    }
  })

  it('finishes application shutdown while a background stop waits on a locked row', async () => {
    const first = await runningBox()
    const next = await runningBox()
    await boxes.update(first.id, { createdAt: new Date(Date.now() - 60_000) })
    states.set(organizationId, 'NEGATIVE')
    const application = await Test.createTestingModule({
      providers: [{ provide: BoxBillingStateService, useValue: worker }],
    }).compile()
    const app = application.createNestApplication({ logger: false })
    const blocker = dataSource.createQueryRunner()
    let run: Promise<void> | undefined
    let closing: Promise<void> | undefined

    try {
      await app.init()
      await blocker.connect()
      await blocker.startTransaction()
      const [{ pid }] = await blocker.query('SELECT pg_backend_pid()::int AS pid')
      await blocker.manager.findOneOrFail(Box, {
        where: { id: first.id },
        lock: { mode: 'pessimistic_write' },
      })
      run = worker.reconcile()
      expect(await blockedBy(pid)).toEqual(expect.any(Number))

      closing = app.close()
      expect(await settlesWithin(closing, 2_000)).toBe(true)
      await run

      expect(blocker.isTransactionActive).toBe(true)
      expect(stopped).toHaveLength(0)
      for (const box of [first, next]) {
        expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
          desiredState: BoxDesiredState.STARTED,
          pending: false,
        })
      }
      expect(await redis.exists(...lockKeys)).toBe(0)
      await worker.reconcile()
      expect(requests).toHaveLength(1)
    } finally {
      try {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await Promise.all([run, closing ?? app.close()])
      } finally {
        await blocker.release()
      }
    }
  }, 15_000)

  it('A4: restart while still NEGATIVE produces a second Stop intent on the next sweep', async () => {
    const box = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    await worker.reconcile()
    await expectStopIntent(box)
    await finishStopAndRestart(box)
    await worker.reconcile()
    await expectStopIntent(box)
    expect(stopped.filter((event) => event.box.id === box.id)).toHaveLength(2)
    expect(requests).toHaveLength(2)
  })

  it('uses the real Redis lease to keep a second instance out of an active sweep', async () => {
    const box = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    requestGate = { entered: deferred(), release: deferred() }
    const first = worker.reconcile()
    try {
      await requestGate.entered.promise
      const other = new BoxBillingStateService(config, repository, boxService, locks())
      await other.reconcile()
      expect(requests).toHaveLength(1)
      expect(stopped).toHaveLength(0)
    } finally {
      requestGate.release.resolve()
      await first
    }
    await expectStopIntent(box)
    expect(stopped).toHaveLength(1)
  })

  it.each([401, 500, 503])('HTTP %s does not stop a Box and a later valid response retries', async (status) => {
    const box = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    responseStatus = status
    await worker.reconcile()
    expect(stopped).toHaveLength(0)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
    responseStatus = 200
    await worker.reconcile()
    await expectStopIntent(box)
  })

  it('isolates explicit errors and absent entries from eligible rows', async () => {
    const eligible = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    const unchanged = await Promise.all(
      ['POSITIVE', 'ZERO', 'ERROR', undefined].map(async (state) => {
        const owner = randomUUID()
        if (state) states.set(owner, state)
        return runningBox(owner)
      }),
    )

    await worker.reconcile()

    await expectStopIntent(eligible)
    expect(stopped.map((event) => event.box.id)).toEqual([eligible.id])
    for (const box of unchanged) {
      expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
    }
    expect(requests).toHaveLength(1)
  })

  it('bounds candidate selection blocked by a table lock and releases the lease before retrying', async () => {
    const box = await runningBox()
    states.set(organizationId, 'NEGATIVE')
    const blocker = dataSource.createQueryRunner()
    let run: Promise<void> | undefined
    try {
      await blocker.connect()
      await blocker.startTransaction()
      const [{ pid }] = await blocker.query('SELECT pg_backend_pid()::int AS pid')
      await blocker.query(`LOCK TABLE "${schemaName}"."box" IN ACCESS EXCLUSIVE MODE`)
      run = worker.reconcile()
      expect(await blockedBy(pid)).toEqual(expect.any(Number))

      expect(await settlesWithin(run, 2_000)).toBe(true)
      expect(blocker.isTransactionActive).toBe(true)
      expect(stopped).toHaveLength(0)
      expect(await redis.exists(...lockKeys)).toBe(0)

      await blocker.rollbackTransaction()
      await worker.reconcile()
      await expectStopIntent(box)
    } finally {
      const closing = worker.beforeApplicationShutdown()
      if (blocker.isTransactionActive) await blocker.rollbackTransaction()
      await Promise.all([run, closing])
      await blocker.release()
    }
  }, 10_000)

  it('keeps all rows unchanged for an empty snapshot', async () => {
    const box = await runningBox()

    await worker.reconcile()

    expect(stopped).toHaveLength(0)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['non-array body', { organizationId, billingState: 'NEGATIVE', evaluatedAt: new Date().toISOString() }],
    ['unknown state', [{ organizationId, billingState: 'UNKNOWN', evaluatedAt: new Date().toISOString() }]],
    ['invalid evaluation time', [{ organizationId, billingState: 'NEGATIVE', evaluatedAt: 'not-a-date' }]],
  ])('ignores invalid snapshot data: %s', async (_description, body) => {
    const box = await runningBox()
    responseOverride = body
    await worker.reconcile()
    expect(stopped).toHaveLength(0)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
  })
})
