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
