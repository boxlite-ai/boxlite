/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import axios, { AxiosError } from 'axios'
import { CronExpression } from '@nestjs/schedule'
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants'
import { QueryFailedError } from 'typeorm'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxBillingStateService } from './box-billing-state.service'

const get = jest.spyOn(axios, 'get') as jest.Mock
const EVALUATED_AT = '2026-11-06T10:00:00.000Z'
const EPOCH = Date.parse(EVALUATED_AT)
const box = (id = 'box-1', organizationId = 'org-1') => ({ id, organizationId, createdAt: new Date(EPOCH) })
const state = (organizationId = 'org-1', billingState = 'NEGATIVE') => ({
  organizationId,
  billingState,
  evaluatedAt: EVALUATED_AT,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}

function makeService(
  candidates = [box()],
  overrides: Record<string, unknown> = {},
  checkpoint = { value: null as string | null },
) {
  const settings: Record<string, unknown> = {
    billingApiUrl: 'https://service.test/api/billing/',
    'usageExport.url': 'https://service.test',
    'usageExport.token': 'service-token',
    ...overrides,
  }
  const config = { get: jest.fn((key: string) => settings[key]) }
  const boxes = { findRunningForStop: jest.fn().mockResolvedValue(candidates) }
  const boxService = { stop: jest.fn().mockResolvedValue(undefined) }
  const ownership = new AbortController()
  const lease = {
    signal: ownership.signal,
    release: jest.fn().mockResolvedValue(undefined),
    readCheckpoint: jest.fn(async () => checkpoint.value),
    saveCheckpoint: jest.fn(async (value: string) => {
      checkpoint.value = value
    }),
  }
  const locks = { acquireLease: jest.fn().mockResolvedValue(lease) }
  const service = new BoxBillingStateService(config as never, boxes as never, boxService as never, locks as never)
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  Object.assign(service, { logger })
  return { service, settings, boxes, boxService, ownership, lease, locks, logger, checkpoint }
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: [state()] })
})
afterEach(() => {
  jest.useRealTimers()
})

describe('BoxBillingStateService', () => {
  it('uses one aggregate request for all running organizations', async () => {
    const harness = makeService([box(), box('box-2', 'org-2')])
    get.mockResolvedValue({ data: [state(), state('org-2')] })

    await harness.service.reconcile()

    expect(get.mock.calls.map(([url]) => url)).toEqual(['https://service.test/internal/billing-states'])
    expect(get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        timeout: 2_000,
        maxRedirects: 0,
        headers: { authorization: 'Bearer service-token' },
        signal: expect.any(AbortSignal),
      }),
    )
    expect(harness.boxes.findRunningForStop).toHaveBeenCalledTimes(1)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
  })

  it('does no work without a configured URL', async () => {
    const harness = makeService(undefined, { billingApiUrl: undefined })
    await harness.service.reconcile()
    expect(harness.locks.acquireLease).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(harness.boxes.findRunningForStop).not.toHaveBeenCalled()
  })

  it('uses the internal base and preserves its path prefix', async () => {
    const harness = makeService(undefined, { 'usageExport.url': 'https://internal.test/gateway' })
    await harness.service.reconcile()
    expect(get.mock.calls.map(([url]) => url)).toEqual(['https://internal.test/gateway/internal/billing-states'])
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
  })

  it('gives background stops a bounded lock wait', async () => {
    const harness = makeService()
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledWith(
      'box-1',
      'org-1',
      expect.objectContaining({ lockTimeoutMs: 500 }),
    )
  })

  it.each([
    ['55P03', 'lock_timeout'],
    ['57014', 'QueryFailedError'],
  ])('categorizes database failure %s without logging query details', async (code, reason) => {
    const harness = makeService([box(), box('box-2')])
    harness.boxService.stop.mockRejectedValueOnce(
      new QueryFailedError('private query', ['private parameter'], Object.assign(new Error('private error'), { code })),
    )
    await harness.service.reconcile()
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing_stop_failed', boxId: 'box-1', reason }),
    )
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('private')
  })

  it.each(['usageExport.url', 'usageExport.token'])('requires %s and recovers when restored', async (setting) => {
    const harness = makeService(undefined, { [setting]: undefined })
    await harness.service.reconcile()
    expect(harness.locks.acquireLease).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(harness.logger.error).toHaveBeenCalledWith({ event: 'billing_poll_failed', reason: 'Error' })
    harness.settings['usageExport.url'] = 'https://service.test'
    harness.settings['usageExport.token'] = 'restored-token'
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { authorization: 'Bearer restored-token' } }),
    )
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
  })

  it('schedules every 30 seconds without overlapping callbacks', () => {
    expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, BoxBillingStateService.prototype.reconcile)).toEqual(
      expect.objectContaining({ cronTime: CronExpression.EVERY_30_SECONDS, waitForCompletion: true }),
    )
  })

  it('queries settled Running Boxes once and stops only organizations present as NEGATIVE', async () => {
    const harness = makeService([
      box(),
      box('positive', 'positive'),
      box('zero', 'zero'),
      box('missing', 'missing'),
      box('error', 'error'),
    ])
    get.mockResolvedValue({
      data: [
        { ...state(), privateDetails: 'private-response' },
        state('positive', 'POSITIVE'),
        state('zero', 'ZERO'),
        { ...state('error', 'ERROR'), errorCode: 'SETTLEMENT_HALTED', privateDetails: 'private-response' },
        state(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
      ],
    })
    await harness.service.reconcile()
    expect(harness.boxes.findRunningForStop).toHaveBeenCalledTimes(1)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
    expect(harness.boxService.stop).toHaveBeenCalledWith(
      'box-1',
      'org-1',
      expect.objectContaining({ ...Context.platform(PlatformReason.BILLING_NEGATIVE), lockTimeoutMs: 500 }),
    )
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_state_unavailable',
        organizationId: 'error',
        errorCode: 'SETTLEMENT_HALTED',
      }),
    )
    expect(harness.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_stop_accepted',
        organizationId: 'org-1',
        boxId: 'box-1',
        billingState: 'NEGATIVE',
        evaluatedAt: EVALUATED_AT,
        observedAt: expect.any(String),
        durationMs: expect.any(Number),
      }),
    )
    expect(JSON.stringify(Object.values(harness.logger).flatMap((method) => method.mock.calls))).not.toContain(
      'private-response',
    )
  })

  it.each(['POSITIVE', 'ZERO'])(
    'leaves %s organizations alone, including recovery on the next sweep',
    async (value) => {
      const harness = makeService()
      await harness.service.reconcile()
      get.mockResolvedValue({ data: [state('org-1', value)] })
      await harness.service.reconcile()
      expect(get).toHaveBeenCalledTimes(2)
      expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
      expect(harness.boxes.findRunningForStop).toHaveBeenCalledTimes(1)
    },
  )

  it('resubmits a stop when the same Box is running in a later negative snapshot', async () => {
    const harness = makeService()
    await harness.service.reconcile()
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(2)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
  })

  it('reuses one snapshot during its window and refreshes the next sweep', async () => {
    const harness = makeService([box(), box('box-2')])
    harness.boxService.stop.mockImplementationOnce(async () => {
      get.mockResolvedValue({ data: [state('org-1', 'POSITIVE')] })
    })
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(1)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(2)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
  })

  it.each([
    { label: 'empty', data: [] },
    { label: 'positive', data: [state('org-1', 'POSITIVE')] },
    { label: 'warm pool', data: [state(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)] },
  ])('does not query Boxes for a $label snapshot', async ({ data }) => {
    const harness = makeService()
    get.mockResolvedValue({ data })
    await harness.service.reconcile()
    expect(harness.boxes.findRunningForStop).not.toHaveBeenCalled()
    expect(harness.boxService.stop).not.toHaveBeenCalled()
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  it.each([null, undefined, {}, 42])('rejects non-array response %j', async (data) => {
    const harness = makeService()
    get.mockResolvedValue({ data })
    await harness.service.reconcile()
    expect(harness.boxes.findRunningForStop).not.toHaveBeenCalled()
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing_state_failed', reason: 'invalid_response' }),
    )
  })

  it.each([
    null,
    42,
    {},
    { ...state(), organizationId: '' },
    { ...state(), organizationId: 1 },
    { ...state(), billingState: 'UNKNOWN' },
    { ...state(), evaluatedAt: 'invalid' },
    { ...state(), evaluatedAt: undefined },
    { ...state(), evaluatedAt: 0 },
    { ...state(), errorCode: 'SETTLEMENT_HALTED' },
    state('org-1', 'ERROR'),
    { ...state('org-1', 'ERROR'), errorCode: 1 },
  ])('skips malformed item %j without losing healthy organizations', async (invalid) => {
    const harness = makeService([box('healthy', 'healthy')])
    get.mockResolvedValue({ data: [invalid, state('healthy')] })
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
    expect(harness.boxService.stop).toHaveBeenCalledWith('healthy', 'healthy', expect.any(Context))
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing_state_failed', reason: 'invalid_response' }),
    )
  })

  it.each([401, 503, 500, undefined])('does not use a previous snapshot after HTTP %s failure', async (status) => {
    const harness = makeService()
    await harness.service.reconcile()
    get.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNABORTED', response: status ? { status } : undefined })
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(3)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: status ? `HTTP ${status}` : 'ECONNABORTED' }),
    )
  })

  it('isolates stop failures and keeps credentials and response bodies out of logs', async () => {
    const harness = makeService([box(), box('box-2')])
    harness.boxService.stop.mockRejectedValueOnce(new Error('private-error-message'))
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing_stop_failed', boxId: 'box-1', reason: 'Error' }),
    )
    get.mockRejectedValueOnce({
      isAxiosError: true,
      config: { headers: { authorization: 'Bearer secret-token' } },
      response: { status: 401, data: 'private-response' },
      message: 'private-error-message',
    })
    await harness.service.reconcile()
    expect(harness.logger.error).toHaveBeenCalledWith(expect.objectContaining({ reason: 'HTTP 401' }))
    expect(JSON.stringify(Object.values(harness.logger).flatMap((method) => method.mock.calls))).not.toMatch(
      /secret-token|private-response|private-error-message/,
    )
  })

  it.each([
    [new AxiosError('private details'), 'transport_error'],
    ['private details', 'unknown_error'],
  ])('categorizes transport failure %# without exposing details', async (failure, reason) => {
    const harness = makeService()
    get.mockRejectedValueOnce(failure)
    await harness.service.reconcile()
    expect(harness.logger.error).toHaveBeenCalledWith(expect.objectContaining({ reason }))
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain('private details')
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  it('skips another lease owner and prevents local overlap while acquiring a lease', async () => {
    const harness = makeService()
    harness.locks.acquireLease.mockResolvedValueOnce(null)
    await harness.service.reconcile()
    expect(get).not.toHaveBeenCalled()
    const acquired = deferred<typeof harness.lease>()
    harness.locks.acquireLease.mockReturnValueOnce(acquired.promise)
    const first = harness.service.reconcile()
    const second = harness.service.reconcile()
    expect(harness.locks.acquireLease).toHaveBeenCalledTimes(2)
    acquired.resolve(harness.lease)
    await Promise.all([first, second])
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'shutdown'])('bounds lease acquisition on %s and releases late success', async (reason) => {
    const harness = makeService()
    const acquired = deferred<'OK'>()
    const redis = { set: jest.fn().mockReturnValueOnce(acquired.promise), eval: jest.fn().mockResolvedValue(1) }
    Object.assign(harness.service, { locks: new RedisLockProvider(redis as never) })
    const run = harness.service.reconcile()
    const operation = reason === 'shutdown' ? harness.service.beforeApplicationShutdown() : run
    let settled = false
    void operation.then(() => (settled = true))

    try {
      await new Promise((resolve) => setTimeout(resolve, reason === 'timeout' ? 1_100 : 0))
      expect(settled).toBe(true)
      expect(get).not.toHaveBeenCalled()
      expect(harness.boxService.stop).not.toHaveBeenCalled()
      if (reason === 'timeout') {
        redis.set.mockResolvedValueOnce(null)
        await harness.service.reconcile()
        expect(redis.set).toHaveBeenCalledTimes(2)
      }
    } finally {
      const shutdown = harness.service.beforeApplicationShutdown()
      acquired.resolve('OK')
      await Promise.all([run, shutdown])
      await new Promise(setImmediate)
    }

    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'commerce-billing-state',
      redis.set.mock.calls[0][1],
    )
  })

  it('preserves query and lease-release failures and recovers next sweep', async () => {
    const harness = makeService()
    harness.boxes.findRunningForStop.mockRejectedValueOnce(
      Object.assign(new Error('private query'), { name: 'QueryFailedError' }),
    )
    harness.lease.release.mockRejectedValueOnce(
      Object.assign(new Error('private release'), { name: 'LockOwnershipLostError' }),
    )
    await harness.service.reconcile()
    expect(harness.logger.error).toHaveBeenCalledWith({
      event: 'billing_lock_release_failed',
      reason: 'LockOwnershipLostError',
    })
    expect(harness.logger.error).toHaveBeenCalledWith({ event: 'billing_poll_failed', reason: 'QueryFailedError' })
    await harness.service.reconcile()
    expect(harness.lease.release).toHaveBeenCalledTimes(2)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['lease loss', 'shutdown'])('cancels a pending request on %s', async (reason) => {
    const harness = makeService()
    const requested = deferred<AbortSignal>()
    get.mockImplementation((_url: string, { signal }: { signal: AbortSignal }) => {
      requested.resolve(signal)
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    const run = harness.service.reconcile()
    const signal = await requested.promise
    if (reason === 'lease loss') harness.ownership.abort()
    else await harness.service.beforeApplicationShutdown()
    await run
    expect(signal.aborted).toBe(true)
    expect(harness.boxService.stop).not.toHaveBeenCalled()
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  it('waits for an accepted stop after cancellation without submitting another', async () => {
    const harness = makeService([box(), box('box-2')])
    const stopping = deferred<void>()
    const started = deferred<void>()
    harness.boxService.stop.mockImplementationOnce(() => {
      started.resolve()
      return stopping.promise
    })
    const run = harness.service.reconcile()
    await started.promise
    const shutdown = harness.service.beforeApplicationShutdown()
    expect(harness.lease.release).not.toHaveBeenCalled()
    stopping.resolve()
    await Promise.all([run, shutdown])
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each([29_999, 30_000, 30_001])(
    'counts request and candidate-query time in the %i ms snapshot boundary',
    async (elapsed) => {
      jest.useFakeTimers()
      jest.setSystemTime(EPOCH)
      const harness = makeService()
      get.mockImplementation(async () => {
        jest.setSystemTime(EPOCH + 1_999)
        return { data: [state()] }
      })
      harness.boxes.findRunningForStop.mockImplementation(async () => {
        jest.setSystemTime(EPOCH + elapsed)
        return [box()]
      })
      await harness.service.reconcile()
      expect(harness.boxService.stop).toHaveBeenCalledTimes(elapsed < 30_000 ? 1 : 0)
      if (elapsed >= 30_000)
        expect(harness.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'billing_snapshot_expired' }))
    },
  )

  it('continues past timed-out candidates when another worker takes the next lease', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(EPOCH)
    const candidates = Array.from({ length: 61 }, (_, index) => box(`box-${String(index).padStart(3, '0')}`))
    const first = makeService(candidates)
    const last = candidates[60]
    const stop = async (id: string) => {
      if (id !== last.id) {
        jest.setSystemTime(Date.now() + 500)
        throw new QueryFailedError('stop', [], { code: '55P03' } as never)
      }
    }
    first.boxService.stop.mockImplementation(stop)
    await first.service.reconcile()
    expect(first.boxService.stop).toHaveBeenCalledTimes(60)

    const successor = makeService(candidates, {}, first.checkpoint)
    successor.boxService.stop.mockImplementation(stop)
    await successor.service.reconcile()

    expect(successor.boxService.stop.mock.calls[0][0]).toBe(last.id)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('resumes after a removed cursor Box and wraps to earlier candidates', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(EPOCH)
    const first = makeService([box('box-1'), box('box-2')])
    first.boxService.stop.mockImplementationOnce(async () => {
      jest.setSystemTime(EPOCH + 30_000)
    })
    await first.service.reconcile()

    const successor = makeService([box('box-0'), box('box-2')], {}, first.checkpoint)
    await successor.service.reconcile()

    expect(successor.boxService.stop.mock.calls.map(([id]) => id)).toEqual(['box-2', 'box-0'])
  })

  it('finishes an accepted stop across the deadline and handles remaining Boxes next sweep', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(EPOCH)
    const harness = makeService([box(), box('box-2')])
    harness.boxService.stop.mockImplementationOnce(async () => {
      jest.setSystemTime(EPOCH + 30_000)
    })
    await harness.service.reconcile()
    expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
    harness.boxes.findRunningForStop.mockResolvedValue([box('box-2')])
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(2)
    expect(harness.boxService.stop).toHaveBeenLastCalledWith('box-2', 'org-1', expect.any(Context))
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
  })

  it.each([
    [120_000, false],
    [120_001, true],
  ])('reports an accepted stop taking the sweep to %i ms', async (elapsed, slow) => {
    jest.useFakeTimers()
    jest.setSystemTime(EPOCH)
    const harness = makeService()
    harness.boxService.stop.mockImplementation(async () => {
      jest.setSystemTime(EPOCH + Number(elapsed))
    })
    await harness.service.reconcile()
    expect(harness.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing_poll_completed', durationMs: elapsed, stopAcceptedCount: 1 }),
    )
    expect(harness.logger.warn.mock.calls.some(([entry]) => entry.event === 'billing_poll_slow')).toBe(slow)
    expect(harness.lease.release).toHaveBeenCalledTimes(1)
  })

  it('handles a newly running organization missed by one snapshot on the next 30-second sweep', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(EPOCH)
    let sourceStates = [state()]
    let runningBoxes = [box()]
    const harness = makeService()
    harness.boxes.findRunningForStop.mockImplementation(async () => runningBoxes.map((candidate) => ({ ...candidate })))
    const captured = deferred<void>()
    const reply = deferred<void>()
    get.mockImplementation(async () => ({ data: sourceStates.map((entry) => ({ ...entry })) }))
    get.mockImplementationOnce(async () => {
      const data = sourceStates.map((entry) => ({ ...entry }))
      captured.resolve()
      await reply.promise
      return { data }
    })
    const acceptedAt = new Map<string, number>()
    harness.boxService.stop.mockImplementation(async (boxId: string) => {
      acceptedAt.set(boxId, Date.now())
      runningBoxes = runningBoxes.filter((candidate) => candidate.id !== boxId)
    })

    await jest.advanceTimersByTimeAsync(30_000)
    const first = harness.service.reconcile()
    await captured.promise
    const newlyRunningAt = Date.now()
    sourceStates = [...sourceStates, state('new-org')]
    runningBoxes = [...runningBoxes, box('new-box', 'new-org')]
    reply.resolve()
    await first
    expect(get).toHaveBeenCalledTimes(1)
    expect(acceptedAt.has('new-box')).toBe(false)

    await jest.advanceTimersByTimeAsync(30_000)
    await harness.service.reconcile()
    expect(get).toHaveBeenCalledTimes(2)
    expect(harness.boxes.findRunningForStop).toHaveBeenCalledTimes(2)
    expect(harness.boxService.stop).toHaveBeenCalledTimes(2)
    expect(acceptedAt.get('new-box')).toBeLessThan(newlyRunningAt + 300_000)
  })

  it.each([1, 30])(
    'submits 30 Boxes serially across %i organizations with one snapshot within five minutes',
    async (organizations) => {
      jest.useFakeTimers()
      jest.setSystemTime(EPOCH)
      const candidates = Array.from({ length: 30 }, (_, i) => box(`box-${i}`, `org-${i % organizations}`))
      const harness = makeService(candidates)
      get.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        return { data: Array.from({ length: organizations }, (_, i) => state(`org-${i}`)) }
      })
      let active = 0
      let peak = 0
      const acceptedAt: number[] = []
      harness.boxService.stop.mockImplementation(async () => {
        peak = Math.max(peak, ++active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active--
        acceptedAt.push(Date.now())
      })
      await jest.advanceTimersByTimeAsync(30_000)
      const run = harness.service.reconcile()
      await jest.advanceTimersByTimeAsync(3_000)
      await run
      expect(get).toHaveBeenCalledTimes(1)
      expect(harness.boxes.findRunningForStop).toHaveBeenCalledTimes(1)
      expect(harness.boxService.stop).toHaveBeenCalledTimes(30)
      expect(peak).toBe(1)
      expect(Math.max(...acceptedAt) - EPOCH).toBeLessThan(300_000)
    },
  )
})
