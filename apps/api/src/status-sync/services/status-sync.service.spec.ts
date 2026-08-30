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
  // A Map/Set-backed Redis lets damping and retirement tests run several real
  // ticks in sequence, mirroring the string keys + the known-components set.
  const store = new Map<string, string>()
  const knownIds = new Set<string>()
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key)
      return 1
    }),
    sadd: jest.fn(async (_set: string, id: string) => {
      knownIds.add(id)
      return 1
    }),
    srem: jest.fn(async (_set: string, id: string) => {
      knownIds.delete(id)
      return 1
    }),
    smembers: jest.fn(async () => [...knownIds]),
  }
  const incidentIoClient = {
    sendAlertEvent: jest.fn().mockResolvedValue(undefined),
    pingHeartbeat: jest.fn().mockResolvedValue(undefined),
  }
  const lease = { signal: new AbortController().signal, release: jest.fn().mockResolvedValue(undefined) }
  const redisLockProvider = { acquireLease: jest.fn().mockResolvedValue(lease) }

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
    knownIds,
    redis,
    incidentIoClient,
    lease,
    redisLockProvider,
  }
}

type Harness = ReturnType<typeof makeService>

const seed = (harness: Harness, id: string, sent: 'firing' | 'resolved', streak = 0) => {
  harness.store.set(`status-sync:component:${id}`, JSON.stringify({ sent, streak }))
  harness.knownIds.add(id)
}

const seedAllResolved = (harness: Harness) => {
  seed(harness, 'api', 'resolved')
  seed(harness, 'boxes-us', 'resolved')
  seed(harness, 'box-ingress-us', 'resolved')
}

beforeEach(() => {
  probeGet.mockReset()
  probeGet.mockResolvedValue({ status: 200 })
})

describe('StatusSyncService', () => {
  it('does nothing while disabled', async () => {
    const harness = makeService({ 'incidentIo.enabled': false })

    await harness.service.syncStatus()

    expect(harness.redisLockProvider.acquireLease).not.toHaveBeenCalled()
    expect(harness.regionRepository.find).not.toHaveBeenCalled()
    expect(harness.runnerRepository.find).not.toHaveBeenCalled()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
    expect(harness.redis.get).not.toHaveBeenCalled()
  })

  it('yields to whichever replica holds the lease', async () => {
    const harness = makeService()
    harness.redisLockProvider.acquireLease.mockResolvedValue(null)

    await harness.service.syncStatus()

    expect(harness.regionRepository.find).not.toHaveBeenCalled()
    expect(harness.incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
  })

  it('derives the initial lease TTL from both configured timeouts plus the margin', async () => {
    const harness = makeService({ 'incidentIo.timeoutMs': 7_000, 'incidentIo.probeTimeoutMs': 3_000 })
    seedAllResolved(harness)

    await harness.service.syncStatus()

    expect(harness.redisLockProvider.acquireLease).toHaveBeenCalledWith(
      'status-sync',
      Math.ceil((7_000 + 3_000 + 30_000) / 1000),
    )
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  // Unknown last-sent state must send an observed recovery undamped: after a
  // Redis flush mid-incident, the resolved event has to reach incident.io or
  // its alert stays firing forever.
  it('sends an observed recovery immediately when Redis holds no state', async () => {
    const harness = makeService()

    await harness.service.syncStatus()

    const statuses = harness.incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => event.status)
    expect(statuses).toEqual(['resolved', 'resolved', 'resolved'])
    expect(harness.redis.set).toHaveBeenCalledWith(
      'status-sync:component:api',
      JSON.stringify({ sent: 'resolved', streak: 0 }),
      'EX',
      86_400,
    )
    expect(harness.knownIds).toEqual(new Set(['api', 'boxes-us', 'box-ingress-us']))
  })

  // ...but an observed failure with no state only seeds the streak — a single
  // bad probe on a component's first tick must not bypass FIRE_AFTER_TICKS.
  it('damps a firing observation even when Redis holds no state', async () => {
    const harness = makeService()
    seed(harness, 'boxes-us', 'resolved')
    seed(harness, 'box-ingress-us', 'resolved')
    harness.dbHealth.pingCheck.mockRejectedValue(new Error('db down'))

    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 1 }))

    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()

    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'firing',
        deduplicationKey: 'boxlite-test-api',
        description: 'API dependency check failed: database',
      }),
    )
  })

  it('sends nothing and resets the streak when nothing changed', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'api', 'resolved', 2)

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 0 }))
  })

  it('fires only after three consecutive bad ticks', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    harness.redisHealth.isHealthy.mockResolvedValue({ redis: { status: 'down' } })

    await harness.service.syncStatus()
    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()

    await harness.service.syncStatus()
    const firing = harness.incidentIoClient.sendAlertEvent.mock.calls.filter(([event]) => event.status === 'firing')
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
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'boxes-us', 'firing')

    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()

    await harness.service.syncStatus()
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        deduplicationKey: 'boxlite-test-boxes-us',
        description: 'Recovered. All 1 runners responsive',
      }),
    )
  })

  it('never sends when a blip flaps back before the threshold', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    harness.redisHealth.isHealthy.mockResolvedValueOnce({ redis: { status: 'down' } })
    harness.redisHealth.isHealthy.mockResolvedValueOnce({ redis: { status: 'down' } })

    await harness.service.syncStatus()
    await harness.service.syncStatus()
    await harness.service.syncStatus() // healthy again — resets the streak

    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 0 }))
  })

  // incident.io refusing an event must not lose the transition: the streak
  // stays at threshold so the very next tick retries the send.
  it('keeps the transition pending when incident.io rejects the send', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'api', 'resolved', 2)
    harness.dbHealth.pingCheck.mockRejectedValue(new Error('db down'))
    harness.incidentIoClient.sendAlertEvent.mockRejectedValueOnce(new Error('incident.io 500'))

    await harness.service.syncStatus()
    expect(harness.store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'resolved', streak: 3 }))

    await harness.service.syncStatus()
    const apiEvents = harness.incidentIoClient.sendAlertEvent.mock.calls.filter(
      ([event]) => event.deduplicationKey === 'boxlite-test-api',
    )
    expect(apiEvents).toHaveLength(2)
    expect(harness.store.get('status-sync:component:api')).toBe(JSON.stringify({ sent: 'firing', streak: 0 }))
    expect(harness.incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(2)
  })

  // A crashed evaluator is a probe defect, not an outage: the other components
  // still reconcile, the heartbeat still goes out — and the retirement sweep
  // is skipped, because "missing" is indistinguishable from "unobserved".
  it('skips a crashing evaluator without blocking the others, retiring, or the heartbeat', async () => {
    const harness = makeService()
    seed(harness, 'boxes-eu', 'firing') // would look vanished if the sweep ran
    harness.runnerRepository.find.mockRejectedValue(new Error('query timeout'))

    await harness.service.syncStatus()

    const keys = harness.incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => event.deduplicationKey)
    expect(keys).toEqual(['boxlite-test-api', 'boxlite-test-box-ingress-us'])
    expect(harness.redis.smembers).not.toHaveBeenCalled()
    expect(harness.store.has('status-sync:component:boxes-eu')).toBe(true)
    expect(harness.incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('names every failed API dependency in the detail', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'api', 'resolved', 2)
    harness.dbHealth.pingCheck.mockRejectedValue(new Error('db down'))
    harness.redisHealth.isHealthy.mockResolvedValue({ redis: { status: 'down' } })

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'API dependency check failed: database, redis' }),
    )
  })

  it('fires only the region whose ingress probe fails', async () => {
    const harness = makeService()
    harness.regionRepository.find.mockResolvedValue([usRegion, euRegion])
    harness.runnerRepository.find.mockResolvedValue([
      { region: 'us', state: RunnerState.READY },
      { region: 'eu', state: RunnerState.READY },
    ])
    seed(harness, 'api', 'resolved')
    seed(harness, 'boxes-us', 'resolved')
    seed(harness, 'boxes-eu', 'resolved')
    seed(harness, 'box-ingress-us', 'resolved')
    seed(harness, 'box-ingress-eu', 'resolved', 2)
    probeGet.mockImplementation(async (url: string) => {
      // Exact match, not startsWith: a prefix check on a URL is the CodeQL
      // "incomplete URL substring sanitization" pattern even in a fixture.
      if (url === 'https://proxy.eu.test/health') {
        throw Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' })
      }
      return { status: 200 }
    })

    await harness.service.syncStatus()

    const byKey = Object.fromEntries(
      harness.incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => [event.deduplicationKey, event]),
    )
    expect(Object.keys(byKey)).toEqual(['boxlite-test-box-ingress-eu'])
    expect(byKey['boxlite-test-box-ingress-eu']).toEqual(
      expect.objectContaining({
        status: 'firing',
        title: 'Box Ingress degraded (eu)',
        metadata: expect.objectContaining({ component: 'box-ingress', region: 'eu' }),
      }),
    )
    expect(probeGet).toHaveBeenCalledWith('https://proxy.us.test/health', { timeout: 5_000 })
    expect(probeGet).toHaveBeenCalledWith('https://proxy.eu.test/health', { timeout: 5_000 })
  })

  it('skips regions without a proxy URL and never probes them', async () => {
    const harness = makeService()
    harness.regionRepository.find.mockResolvedValue([{ id: 'us', regionType: RegionType.SHARED, proxyUrl: null }])
    seed(harness, 'api', 'resolved')
    seed(harness, 'boxes-us', 'resolved')

    await harness.service.syncStatus()

    expect(probeGet).not.toHaveBeenCalled()
    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.store.has('status-sync:component:box-ingress-us')).toBe(false)
  })

  it('queries only traffic-carrying runners in shared regions', async () => {
    const harness = makeService()
    seedAllResolved(harness)

    await harness.service.syncStatus()

    expect(harness.regionRepository.find).toHaveBeenCalledWith({ where: { regionType: RegionType.SHARED } })
    expect(harness.runnerRepository.find).toHaveBeenCalledWith({
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
      { sent: 'firing', seeded: 'resolved' as const, description: 'Unresponsive runners: 1/2' },
    ],
    [
      'an all-ready region reports recovered counts',
      [
        { region: 'us', state: RunnerState.READY },
        { region: 'us', state: RunnerState.READY },
      ],
      { sent: 'resolved', seeded: 'firing' as const, description: 'Recovered. All 2 runners responsive' },
    ],
  ])('%s', async (_case, runners, expected) => {
    const harness = makeService()
    seed(harness, 'api', 'resolved')
    seed(harness, 'box-ingress-us', 'resolved')
    seed(harness, 'boxes-us', expected.seeded, 2)
    harness.runnerRepository.find.mockResolvedValue(runners)

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        deduplicationKey: 'boxlite-test-boxes-us',
        status: expected.sent,
        description: expected.description,
      }),
    )
  })

  it('emits no boxes observation for a region with no eligible runners', async () => {
    const harness = makeService()
    seed(harness, 'api', 'resolved')
    seed(harness, 'box-ingress-us', 'resolved')
    harness.runnerRepository.find.mockResolvedValue([])

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).not.toHaveBeenCalled()
    expect(harness.store.has('status-sync:component:boxes-us')).toBe(false)
  })

  // A component the evaluators stopped returning must not leave its alert
  // firing forever: the sweep resolves it, then drops the local state.
  it('retires a vanished component by resolving its alert and dropping its state', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'box-ingress-eu', 'firing') // its region no longer exists

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        deduplicationKey: 'boxlite-test-box-ingress-eu',
        title: 'Box Ingress degraded (eu)',
        metadata: expect.objectContaining({ component: 'box-ingress', region: 'eu' }),
      }),
    )
    expect(harness.store.has('status-sync:component:box-ingress-eu')).toBe(false)
    expect(harness.knownIds.has('box-ingress-eu')).toBe(false)
  })

  // Resolved-state orphans get the resolve too: stored state can lag reality
  // by one failed write, and a redundant resolved event is an idempotent
  // no-op under the dedup key.
  it('retires a vanished component even when its stored state says resolved', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'boxes-eu', 'resolved')

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledTimes(1)
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', deduplicationKey: 'boxlite-test-boxes-eu' }),
    )
    expect(harness.store.has('status-sync:component:boxes-eu')).toBe(false)
    expect(harness.knownIds.has('boxes-eu')).toBe(false)
  })

  // A stalled DB read must reject the evaluator instead of holding the
  // self-renewing lease forever and blocking every later tick.
  it('deadlines a hung runner query and keeps the rest of the tick alive', async () => {
    const harness = makeService({ 'incidentIo.probeTimeoutMs': 20 })
    seed(harness, 'boxes-eu', 'firing') // must NOT be retired on a partial tick
    harness.runnerRepository.find.mockReturnValue(new Promise(() => undefined))

    await harness.service.syncStatus()

    const keys = harness.incidentIoClient.sendAlertEvent.mock.calls.map(([event]) => event.deduplicationKey)
    expect(keys).toEqual(['boxlite-test-api', 'boxlite-test-box-ingress-us'])
    expect(harness.redis.smembers).not.toHaveBeenCalled()
    expect(harness.store.has('status-sync:component:boxes-eu')).toBe(true)
    expect(harness.incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(1)
  })

  // The send-lands-but-state-write-fails corner: the id is registered before
  // the send, so when the component then vanishes, the sweep can still
  // resolve the orphaned alert even though no state was ever written.
  it('retires a component whose firing send landed but whose state write failed', async () => {
    const harness = makeService()
    seed(harness, 'api', 'resolved')
    seed(harness, 'boxes-us', 'resolved')
    seed(harness, 'box-ingress-us', 'resolved')
    seed(harness, 'box-ingress-eu', 'resolved', 2) // one bad tick from the threshold
    harness.regionRepository.find.mockResolvedValueOnce([usRegion, euRegion]) // boxes evaluator
    harness.regionRepository.find.mockResolvedValueOnce([usRegion, euRegion]) // ingress evaluator
    probeGet.mockImplementation(async (url: string) => {
      if (url === 'https://proxy.eu.test/health') {
        throw Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' })
      }
      return { status: 200 }
    })
    // The firing send succeeds, then that component's state write fails.
    harness.redis.set.mockImplementation(async (key: string, value: string) => {
      if (key === 'status-sync:component:box-ingress-eu') {
        throw new Error('redis write failed')
      }
      harness.store.set(key, value)
      return 'OK'
    })

    await expect(harness.service.syncStatus()).rejects.toThrow('redis write failed')
    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'firing', deduplicationKey: 'boxlite-test-box-ingress-eu' }),
    )
    // The failed write leaves the stale pre-send state behind; only the
    // pre-send set registration reflects reality.
    expect(harness.store.get('status-sync:component:box-ingress-eu')).toBe(
      JSON.stringify({ sent: 'resolved', streak: 2 }),
    )
    expect(harness.knownIds.has('box-ingress-eu')).toBe(true)

    // Next tick: the eu region is gone — the sweep must resolve the orphan.
    harness.incidentIoClient.sendAlertEvent.mockClear()
    harness.regionRepository.find.mockResolvedValue([usRegion])
    await harness.service.syncStatus()

    expect(harness.incidentIoClient.sendAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', deduplicationKey: 'boxlite-test-box-ingress-eu' }),
    )
    expect(harness.knownIds.has('box-ingress-eu')).toBe(false)
  })

  it('keeps a vanished firing component when the retirement send fails', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    seed(harness, 'boxes-eu', 'firing')
    harness.incidentIoClient.sendAlertEvent.mockRejectedValueOnce(new Error('incident.io 500'))

    await harness.service.syncStatus()

    expect(harness.store.has('status-sync:component:boxes-eu')).toBe(true)
    expect(harness.knownIds.has('boxes-eu')).toBe(true)
    expect(harness.incidentIoClient.pingHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('skips the heartbeat when none is configured', async () => {
    const harness = makeService({ 'incidentIo.heartbeatId': undefined })
    seedAllResolved(harness)

    await harness.service.syncStatus()

    expect(harness.incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
  })

  it('logs a failed heartbeat ping without failing the tick', async () => {
    const harness = makeService()
    seedAllResolved(harness)
    harness.incidentIoClient.pingHeartbeat.mockRejectedValue(new Error('503'))

    await expect(harness.service.syncStatus()).resolves.toBeUndefined()
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  // A wedged tick must look dead to incident.io: no ping — but the lease is
  // still released so the next tick can run.
  it('releases the lease and skips the ping when the tick machinery throws', async () => {
    const harness = makeService()
    harness.redis.get.mockRejectedValue(new Error('redis read failed'))

    await expect(harness.service.syncStatus()).rejects.toThrow('redis read failed')
    expect(harness.incidentIoClient.pingHeartbeat).not.toHaveBeenCalled()
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })
})
