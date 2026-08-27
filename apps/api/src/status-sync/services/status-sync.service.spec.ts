/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}))

import axios from 'axios'
import { In } from 'typeorm'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { StatusSyncService } from './status-sync.service'

const probeGet = axios.get as jest.Mock

const CONFIG: Record<string, unknown> = {
  'incidentIo.enabled': true,
  'incidentIo.timeoutMs': 10_000,
  'incidentIo.probeTimeoutMs': 5_000,
  'incidentIo.dedupPrefix': 'boxlite-test',
  'incidentIo.heartbeatId': 'hb-1',
}

const usRegion = { id: 'us', regionType: RegionType.SHARED, proxyUrl: 'https://proxy.us.test' }
const euRegion = { id: 'eu', regionType: RegionType.SHARED, proxyUrl: 'https://proxy.eu.test' }

const makeService = (overrides: Record<string, unknown> = {}) => {
  const configService = {
    get: jest.fn((key: string) => {
      const settings = { ...CONFIG, ...overrides }
      if (!(key in settings)) {
        throw new Error(`status-sync.service.spec: unexpected config key "${key}"`)
      }
      return settings[key]
    }),
  }
  const runnerRepository = { find: jest.fn().mockResolvedValue([{ region: 'us', state: RunnerState.READY }]) }
  const regionRepository = { find: jest.fn().mockResolvedValue([usRegion]) }
  const dbHealth = { pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }) }
  const redisHealth = { isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }) }
  // A Map-backed Redis lets damping tests run several real ticks in sequence.
  const store = new Map<string, string>()
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
  }
  const incidentIoClient = {
    sendAlertEvent: jest.fn().mockResolvedValue(undefined),
    pingHeartbeat: jest.fn().mockResolvedValue(undefined),
  }
  const redisLockProvider = { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) }

  const service = new StatusSyncService(
    runnerRepository as never,
    regionRepository as never,
    dbHealth as never,
    redisHealth as never,
    redis as never,
    incidentIoClient as never,
    redisLockProvider as never,
    configService as never,
  )
  return {
    service,
    runnerRepository,
    regionRepository,
    dbHealth,
    redisHealth,
    store,
    redis,
    incidentIoClient,
    redisLockProvider,
  }
}

const seed = (store: Map<string, string>, id: string, sent: 'firing' | 'resolved', streak = 0) =>
  store.set(`status-sync:component:${id}`, JSON.stringify({ sent, streak }))

const seedAllResolved = (store: Map<string, string>) => {
  seed(store, 'api', 'resolved')
  seed(store, 'boxes-us', 'resolved')
  seed(store, 'box-ingress-us', 'resolved')
}

beforeEach(() => {
  probeGet.mockReset()
  probeGet.mockResolvedValue({ status: 200 })
})

describe('StatusSyncService', () => {
  it('does nothing while disabled', async () => {
    const { service, redisLockProvider, regionRepository, runnerRepository, incidentIoClient, redis } = makeService({
      'incidentIo.enabled': false,
    })

    await service.syncStatus()

    expect(redisLockProvider.lock).not.toHaveBeenCalled()
    expect(regionRepository.find).not.toHaveBeenCalled()
    expect(runnerRepository.find).not.toHaveBeenCalled()
    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
    expect(redis.get).not.toHaveBeenCalled()
  })

  it('yields to whichever replica holds the lock', async () => {
    const { service, redisLockProvider, incidentIoClient, regionRepository } = makeService()
    redisLockProvider.lock.mockResolvedValue(false)

    await service.syncStatus()

    expect(regionRepository.find).not.toHaveBeenCalled()
    expect(incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })

  it('derives the lock TTL from both configured timeouts plus the margin', async () => {
    const { service, redisLockProvider, store } = makeService({
      'incidentIo.timeoutMs': 7_000,
      'incidentIo.probeTimeoutMs': 3_000,
    })
    seedAllResolved(store)

    await service.syncStatus()

    expect(redisLockProvider.lock).toHaveBeenCalledWith('status-sync', Math.ceil((7_000 + 3_000 + 30_000) / 1000))
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('status-sync')
  })

  // Unknown last-sent state must send undamped: a recovery after a Redis flush
  // has to emit resolved or the incident.io alert stays firing forever.
  it('sends the observed status immediately when Redis holds no state', async () => {
    const { service, incidentIoClient, redis } = makeService()

    await service.syncStatus()

    const statuses = incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => event.status)
    expect(statuses).toEqual(['resolved', 'resolved', 'resolved'])
    expect(redis.set).toHaveBeenCalledWith(
      'status-sync:component:api',
      JSON.stringify({ sent: 'resolved', streak: 0 }),
      'EX',
      86_400,
    )
  })

  it('sends firing immediately when Redis holds no state and the component is down', async () => {
    const { service, dbHealth, incidentIoClient, store } = makeService()
    seed(store, 'boxes-us', 'resolved')
    seed(store, 'box-ingress-us', 'resolved')
    dbHealth.pingCheck.mockRejectedValue(new Error('db down'))

    await service.syncStatus()

    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'firing',
        deduplicationKey: 'boxlite-test-api',
        description: 'API dependency check failed: database',
      }),
    )
  })

  it('sends nothing and resets the streak when nothing changed', async () => {
    const { service, incidentIoClient, store } = makeService()
    seed(store, 'api', 'resolved', 2)
    seed(store, 'boxes-us', 'resolved')
    seed(store, 'box-ingress-us', 'resolved')

    await service.syncStatus()

    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 0 }))
  })

  it('fires only after three consecutive bad ticks', async () => {
    const { service, redisHealth, incidentIoClient, store } = makeService()
    seedAllResolved(store)
    redisHealth.isHealthy.mockResolvedValue({ redis: { status: 'down' } })

    await service.syncStatus()
    await service.syncStatus()
    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()

    await service.syncStatus()
    const firing = incidentIoClient.sendAlertEvent.mock.calls.filter(([event]) => event.status === 'firing')
    expect(firing).toHaveLength(1)
    expect(firing[0][0]).toEqual(
      expect.objectContaining({
        deduplicationKey: 'boxlite-test-api',
        title: 'API degraded',
        description: 'API dependency check failed: redis',
        metadata: expect.objectContaining({ component: 'api', source: 'boxlite-status-sync' }),
      }),
    )
  })

  it('resolves after two consecutive good ticks', async () => {
    const { service, incidentIoClient, store } = makeService()
    seedAllResolved(store)
    seed(store, 'boxes-us', 'firing')

    await service.syncStatus()
    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()

    await service.syncStatus()
    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        deduplicationKey: 'boxlite-test-boxes-us',
        description: 'Recovered. All 1 runners responsive',
      }),
    )
  })

  it('never sends when a blip flaps back before the threshold', async () => {
    const { service, redisHealth, incidentIoClient, store } = makeService()
    seedAllResolved(store)
    redisHealth.isHealthy.mockResolvedValueOnce({ redis: { status: 'down' } })
    redisHealth.isHealthy.mockResolvedValueOnce({ redis: { status: 'down' } })

    await service.syncStatus()
    await service.syncStatus()
    await service.syncStatus() // healthy again — resets the streak

    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 0 }))
  })

  // incident.io refusing an event must not lose the transition: the streak
  // stays at threshold so the very next tick retries the send.
  it('keeps the transition pending when incident.io rejects the send', async () => {
    const { service, dbHealth, incidentIoClient, store } = makeService()
    seedAllResolved(store)
    seed(store, 'api', 'resolved', 2)
    dbHealth.pingCheck.mockRejectedValue(new Error('db down'))
    incidentIoClient.sendAlertEvent.mockRejectedValueOnce(new Error('incident.io 500'))

    await service.syncStatus()
    expect(store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 3 }))

    await service.syncStatus()
    const apiEvents = incidentIoClient.sendAlertEvent.mock.calls.filter(
      ([event]) => event.deduplicationKey === 'boxlite-test-api',
    )
    expect(apiEvents).toHaveLength(2)
    expect(store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'firing', streak: 0 }))
    expect(incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(2)
  })

  // A crashed evaluator is a probe defect, not an outage: the other components
  // still reconcile and the heartbeat still goes out.
  it('skips a crashing evaluator without blocking the others or the heartbeat', async () => {
    const { service, runnerRepository, incidentIoClient, store } = makeService()
    runnerRepository.find.mockRejectedValue(new Error('query timeout'))

    await service.syncStatus()

    const keys = incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => event.deduplicationKey)
    expect(keys).toEqual(['boxlite-test-api', 'boxlite-test-box-ingress-us'])
    expect(store.has('status-sync:component:boxes-us')).toBe(false)
    expect(incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('names every failed API dependency in the detail', async () => {
    const { service, dbHealth, redisHealth, incidentIoClient, store } = makeService()
    seed(store, 'boxes-us', 'resolved')
    seed(store, 'box-ingress-us', 'resolved')
    dbHealth.pingCheck.mockRejectedValue(new Error('db down'))
    redisHealth.isHealthy.mockResolvedValue({ redis: { status: 'down' } })

    await service.syncStatus()

    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'API dependency check failed: database, redis' }),
    )
  })

  it('fires only the region whose ingress probe fails', async () => {
    const { service, regionRepository, runnerRepository, incidentIoClient } = makeService()
    regionRepository.find.mockResolvedValue([usRegion, euRegion])
    runnerRepository.find.mockResolvedValue([
      { region: 'us', state: RunnerState.READY },
      { region: 'eu', state: RunnerState.READY },
    ])
    probeGet.mockImplementation(async (url: string) => {
      if (url.startsWith('https://proxy.eu.test')) {
        throw Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' })
      }
      return { status: 200 }
    })

    await service.syncStatus()

    const byKey = Object.fromEntries(
      incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => [event.deduplicationKey, event]),
    )
    expect(byKey['boxlite-test-box-ingress-us'].status).toBe('resolved')
    expect(byKey['boxlite-test-box-ingress-eu']).toEqual(
      expect.objectContaining({
        status: 'firing',
        title: 'Box Ingress degraded (eu)',
        metadata: expect.objectContaining({ component: 'box-ingress', region: 'eu' }),
      }),
    )
    expect(probeGet).toHaveBeenCalledWith('https://proxy.us.test/health', { timeout: 5_000 })
  })

  it('skips regions without a proxy URL and never probes them', async () => {
    const { service, regionRepository, incidentIoClient, store } = makeService()
    regionRepository.find.mockResolvedValue([{ id: 'us', regionType: RegionType.SHARED, proxyUrl: null }])
    seed(store, 'api', 'resolved')
    seed(store, 'boxes-us', 'resolved')

    await service.syncStatus()

    expect(probeGet).not.toHaveBeenCalled()
    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(store.has('status-sync:component:box-ingress-us')).toBe(false)
  })

  it('queries only traffic-carrying runners in shared regions', async () => {
    const { service, runnerRepository, regionRepository, store } = makeService()
    seedAllResolved(store)

    await service.syncStatus()

    expect(regionRepository.find).toHaveBeenCalledWith({ where: { regionType: RegionType.SHARED } })
    expect(runnerRepository.find).toHaveBeenCalledWith({
      select: ['region', 'state'],
      where: {
        region: In(['us']),
        state: In([RunnerState.READY, RunnerState.UNRESPONSIVE]),
        unschedulable: false,
        draining: false,
      },
    })
  })

  it.each([
    [
      'one unresponsive runner fires with the region counts',
      [
        { region: 'us', state: RunnerState.UNRESPONSIVE },
        { region: 'us', state: RunnerState.READY },
      ],
      { status: 'firing', description: 'Unresponsive runners: 1/2' },
    ],
    [
      'an all-ready region reports recovered counts',
      [
        { region: 'us', state: RunnerState.READY },
        { region: 'us', state: RunnerState.READY },
      ],
      { status: 'resolved', description: 'Recovered. All 2 runners responsive' },
    ],
  ])('%s', async (_case, runners, expected) => {
    const { service, runnerRepository, incidentIoClient, store } = makeService()
    seed(store, 'api', 'resolved')
    seed(store, 'box-ingress-us', 'resolved')
    runnerRepository.find.mockResolvedValue(runners)

    await service.syncStatus()

    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationKey: 'boxlite-test-boxes-us', ...expected }),
    )
  })

  it('emits no boxes observation for a region with no eligible runners', async () => {
    const { service, runnerRepository, incidentIoClient, store } = makeService()
    seed(store, 'api', 'resolved')
    seed(store, 'box-ingress-us', 'resolved')
    runnerRepository.find.mockResolvedValue([])

    await service.syncStatus()

    expect(incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(store.has('status-sync:component:boxes-us')).toBe(false)
  })

  it('skips the heartbeat when none is configured', async () => {
    const { service, incidentIoClient, store } = makeService({ 'incidentIo.heartbeatId': undefined })
    seedAllResolved(store)

    await service.syncStatus()

    expect(incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
  })

  it('logs a failed heartbeat ping without failing the tick', async () => {
    const { service, incidentIoClient, redisLockProvider, store } = makeService()
    seedAllResolved(store)
    incidentIoClient.pingHeartbeat.mockRejectedValue(new Error('503'))

    await expect(service.syncStatus()).resolves.toBeUndefined()
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('status-sync')
  })

  // A wedged tick must look dead to incident.io: no ping — but the lock is
  // still released so the next tick can run.
  it('releases the lock and skips the ping when the tick machinery throws', async () => {
    const { service, redis, incidentIoClient, redisLockProvider } = makeService()
    redis.get.mockRejectedValue(new Error('redis read failed'))

    await expect(service.syncStatus()).rejects.toThrow('redis read failed')
    expect(incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('status-sync')
  })
})
