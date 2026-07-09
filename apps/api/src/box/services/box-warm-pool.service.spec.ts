/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxWarmPoolService } from './box-warm-pool.service'
import { WarmPoolEvents } from '../constants/warmpool-events.constants'
import { WarmPoolTopUpRequested } from '../events/warmpool-topup-requested.event'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { ScheduleConfig } from '../entities/warm-pool.entity'
import { BoxConflictError } from '../errors/box-conflict.error'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

// A catch-all window (no days, no hours) always matches, so the resolved target
// is independent of the wall clock — the branch under test stays deterministic
// even though handleBoxOrganizationUpdated resolves against `new Date()`.
const alwaysTarget = (pool: number): ScheduleConfig => ({ windows: [{ pool }] })

function buildHarness(warmPool: unknown, boxCount: number) {
  const warmPoolRepository = { findOne: jest.fn().mockResolvedValue(warmPool) }
  const boxRepository = { count: jest.fn().mockResolvedValue(boxCount) }
  const emit = jest.fn()
  const service = new BoxWarmPoolService(
    warmPoolRepository as never,
    boxRepository as never,
    {} as never, // runnerRepository
    {} as never, // redisLockProvider
    {} as never, // configService
    { emit } as never, // eventEmitter
    {} as never, // redis
  )
  return { service, emit }
}

const claimEvent = () =>
  ({
    newOrganizationId: 'org-real-tenant',
    box: {
      image: 'img',
      class: 'small',
      cpu: 1,
      mem: 1,
      disk: 10,
      region: 'us',
      env: {},
      gpu: 0,
      osUser: 'boxlite',
    },
  }) as never

const warmPool = (over: Record<string, unknown>) => ({
  id: 'wp-1',
  pool: 2,
  timezone: 'UTC',
  scheduleConfig: null,
  image: 'img',
  class: 'small',
  cpu: 1,
  mem: 1,
  disk: 10,
  target: 'us',
  env: {},
  gpu: 0,
  osUser: 'boxlite',
  ...over,
})

describe('BoxWarmPoolService.handleBoxOrganizationUpdated', () => {
  afterEach(() => jest.clearAllMocks())

  it('tops up against the schedule target, not the static pool (the regression this guards)', async () => {
    // Static pool = 2, schedule target = 5, current unassigned boxes = 3.
    // Old code compared `pool(2) <= boxCount(3)` → returned without topping up.
    // Schedule-aware code compares `target(5) <= boxCount(3)` → tops up.
    const { service, emit } = buildHarness(warmPool({ pool: 2, scheduleConfig: alwaysTarget(5) }), 3)

    await service.handleBoxOrganizationUpdated(claimEvent())

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(WarmPoolEvents.TOPUP_REQUESTED, expect.any(WarmPoolTopUpRequested))
  })

  it('does not top up when the schedule target is already met', async () => {
    // Schedule target = 3, boxCount = 3 → at target, no top-up.
    const { service, emit } = buildHarness(warmPool({ pool: 10, scheduleConfig: alwaysTarget(3) }), 3)

    await service.handleBoxOrganizationUpdated(claimEvent())

    expect(emit).not.toHaveBeenCalled()
  })

  it('falls back to the static pool when no schedule is configured', async () => {
    // scheduleConfig null → target is the static pool (4), boxCount 2 → top up.
    const { service, emit } = buildHarness(warmPool({ pool: 4, scheduleConfig: null }), 2)

    await service.handleBoxOrganizationUpdated(claimEvent())

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(WarmPoolEvents.TOPUP_REQUESTED, expect.any(WarmPoolTopUpRequested))
  })

  it('ignores boxes moving back into the unassigned warm-pool organization', async () => {
    const { service, emit } = buildHarness(warmPool({ scheduleConfig: alwaysTarget(5) }), 0)
    const event = { ...(claimEvent() as object), newOrganizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } as never

    await service.handleBoxOrganizationUpdated(event)

    expect(emit).not.toHaveBeenCalled()
  })

  it('does nothing when no matching warm pool exists', async () => {
    const { service, emit } = buildHarness(null, 0)

    await service.handleBoxOrganizationUpdated(claimEvent())

    expect(emit).not.toHaveBeenCalled()
  })
})

interface CheckHarnessOpts {
  boxCount: number
  scheduleConfig?: ScheduleConfig | null
  pool?: number
  candidates?: Array<{ id: string }>
  lockableKey?: (key: string) => boolean
  update?: jest.Mock
  count?: jest.Mock
}

function buildCheckHarness(opts: CheckHarnessOpts) {
  const item = warmPool({ pool: opts.pool ?? 2, scheduleConfig: opts.scheduleConfig ?? null })
  const warmPoolRepository = { find: jest.fn().mockResolvedValue([item]) }
  const count = opts.count ?? jest.fn().mockResolvedValue(opts.boxCount)
  const boxRepository = {
    count,
    find: jest.fn().mockResolvedValue(opts.candidates ?? []),
    update: opts.update ?? jest.fn().mockResolvedValue(undefined),
  }
  const lockableKey = opts.lockableKey ?? (() => true)
  const lock = jest.fn(async (key: string) => lockableKey(key))
  const unlock = jest.fn().mockResolvedValue(undefined)
  const emitAsync = jest.fn().mockResolvedValue([])
  const service = new BoxWarmPoolService(
    warmPoolRepository as never,
    boxRepository as never,
    {} as never, // runnerRepository
    { lock, unlock } as never, // redisLockProvider
    {} as never, // configService
    { emitAsync } as never, // eventEmitter
    {} as never, // redis
  )
  return { service, boxRepository, emitAsync, lock, unlock }
}

describe('BoxWarmPoolService.warmPoolCheck', () => {
  afterEach(() => jest.clearAllMocks())

  it('emits one top-up per missing box when below the schedule target', async () => {
    // target 5 (catch-all), boxCount 2 → missingCount 3.
    const { service, emitAsync, boxRepository, unlock } = buildCheckHarness({
      boxCount: 2,
      scheduleConfig: alwaysTarget(5),
    })

    await service.warmPoolCheck()

    expect(emitAsync).toHaveBeenCalledTimes(3)
    expect(emitAsync).toHaveBeenCalledWith(WarmPoolEvents.TOPUP_REQUESTED, expect.any(WarmPoolTopUpRequested))
    expect(boxRepository.update).not.toHaveBeenCalled()
    expect(unlock).toHaveBeenCalledTimes(1) // outer tick lock released
  })

  it('destroys the excess boxes when above the schedule target', async () => {
    // target 2, boxCount 5 → excessCount 3.
    const candidates = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
    const { service, emitAsync, boxRepository } = buildCheckHarness({
      boxCount: 5,
      scheduleConfig: alwaysTarget(2),
      candidates,
    })

    await service.warmPoolCheck()

    expect(emitAsync).not.toHaveBeenCalled()
    expect(boxRepository.update).toHaveBeenCalledTimes(3)
    expect(boxRepository.update).toHaveBeenCalledWith('b2', {
      updateData: { desiredState: BoxDesiredState.DESTROYED, pending: true },
    })
  })

  it('skips a scale-down candidate that is locked by a concurrent claim', async () => {
    const candidates = [{ id: 'b1' }, { id: 'b2' }]
    const { service, boxRepository } = buildCheckHarness({
      boxCount: 5,
      scheduleConfig: alwaysTarget(3),
      candidates,
      lockableKey: (key) => key !== 'box-warm-pool-b2', // b2 is being claimed
    })

    await service.warmPoolCheck()

    expect(boxRepository.update).toHaveBeenCalledTimes(1)
    expect(boxRepository.update).toHaveBeenCalledWith('b1', expect.anything())
  })

  it('continues scale-down past a BoxConflictError instead of aborting the tick', async () => {
    const candidates = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
    const update = jest.fn(async (id: string) => {
      if (id === 'b2') throw new BoxConflictError() // raced with a claim/destroy
    })
    const { service } = buildCheckHarness({
      boxCount: 5,
      scheduleConfig: alwaysTarget(2),
      candidates,
      update,
    })

    // Must not reject (an unhandled rejection here would fire every ~10s cron tick).
    await expect(service.warmPoolCheck()).resolves.toBeUndefined()
    // b1 and b3 still destroyed despite b2 racing.
    expect(update).toHaveBeenCalledTimes(3)
  })

  it('does no work and does not release a lock it never took when the tick lock is held', async () => {
    const { service, boxRepository, emitAsync, unlock } = buildCheckHarness({
      boxCount: 0,
      scheduleConfig: alwaysTarget(5),
      lockableKey: (key) => !key.startsWith('warm-pool-lock-'), // outer lock unavailable
    })

    await service.warmPoolCheck()

    expect(boxRepository.count).not.toHaveBeenCalled()
    expect(emitAsync).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  it('releases the tick lock even when the box count query throws', async () => {
    const count = jest.fn().mockRejectedValue(new Error('db down'))
    const { service, unlock } = buildCheckHarness({ boxCount: 0, scheduleConfig: alwaysTarget(5), count })

    await service.warmPoolCheck().catch(() => undefined)

    expect(unlock).toHaveBeenCalledTimes(1) // finally ran despite the throw
  })
})
