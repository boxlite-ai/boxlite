/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
  },
}))

import axios from 'axios'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { UsageAllocationSnapshotService } from './usage-allocation-snapshot.service'

const post = axios.post as jest.Mock

const CONFIG: Record<string, unknown> = {
  'usageExport.allocationSnapshotEnabled': true,
  'usageExport.url': 'https://commerce.test',
  'usageExport.token': 'tok-1',
  'usageExport.timeoutMs': 10_000,
}

const openPeriod = (overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod =>
  Object.assign(new BoxUsagePeriod(), {
    id: 'period-1',
    organizationId: 'org-1',
    boxId: 'box-1',
    region: 'us',
    startAt: new Date('2026-08-01T00:00:00.000Z'),
    endAt: null,
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 10,
    ...overrides,
  })

const makeService = (openPeriods: BoxUsagePeriod[], overrides: Record<string, unknown> = {}) => {
  const boxUsagePeriodRepository = { find: jest.fn().mockResolvedValue(openPeriods) }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const configService = {
    get: jest.fn((key: string) => {
      const settings = { ...CONFIG, ...overrides }
      if (!(key in settings)) {
        throw new Error(`usage-allocation-snapshot.service.spec: unexpected config key "${key}"`)
      }
      return settings[key]
    }),
  }

  const service = new UsageAllocationSnapshotService(
    boxUsagePeriodRepository as any,
    redisLockProvider as any,
    configService as any,
  )

  return { service, boxUsagePeriodRepository, redisLockProvider }
}

beforeEach(() => {
  post.mockReset()
})

describe('UsageAllocationSnapshotService.snapshotOpenAllocations', () => {
  it('does nothing while the snapshot is disabled', async () => {
    const { service, boxUsagePeriodRepository } = makeService([openPeriod()], {
      'usageExport.allocationSnapshotEnabled': false,
    })

    await service.snapshotOpenAllocations()

    expect(boxUsagePeriodRepository.find).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('yields to whichever replica holds the lock', async () => {
    const { service, boxUsagePeriodRepository, redisLockProvider } = makeService([openPeriod()])
    redisLockProvider.lock.mockResolvedValue(false)

    await service.snapshotOpenAllocations()

    expect(boxUsagePeriodRepository.find).not.toHaveBeenCalled()
  })

  it('queries only open periods, excluding the warm pool', async () => {
    const { service, boxUsagePeriodRepository } = makeService([openPeriod()])
    post.mockResolvedValue({ status: 200 })

    await service.snapshotOpenAllocations()

    const [query] = boxUsagePeriodRepository.find.mock.calls[0]
    expect(query).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ endAt: expect.anything(), organizationId: expect.anything() }),
      }),
    )
  })

  it('pushes the open periods as a full snapshot with the service token and timeout', async () => {
    const { service } = makeService([openPeriod(), openPeriod({ boxId: 'box-2' })])
    post.mockResolvedValue({ status: 200 })

    await service.snapshotOpenAllocations()

    expect(post).toHaveBeenCalledWith(
      'https://commerce.test/internal/allocation-snapshot',
      expect.objectContaining({
        asOf: expect.any(String),
        allocations: [expect.objectContaining({ boxId: 'box-1' }), expect.objectContaining({ boxId: 'box-2' })],
      }),
      expect.objectContaining({
        timeout: 10_000,
        headers: expect.objectContaining({ authorization: 'Bearer tok-1' }),
      }),
    )
  })

  // Advancing the consumer's asOf watermark when every box has stopped requires
  // sending the empty set, not skipping the push.
  it('still pushes an empty snapshot when no box is open', async () => {
    const { service } = makeService([])
    post.mockResolvedValue({ status: 200 })

    await service.snapshotOpenAllocations()

    expect(post).toHaveBeenCalledWith(
      'https://commerce.test/internal/allocation-snapshot',
      expect.objectContaining({ allocations: [] }),
      expect.anything(),
    )
  })

  // A malformed row is a defect in that one box's data, not in the snapshot as
  // a whole — every other box must still reach Commerce this tick.
  it('skips a row that fails encoding and still sends the rest', async () => {
    const { service } = makeService([openPeriod({ boxId: 'bad', cpu: Number.NaN }), openPeriod({ boxId: 'good' })])
    post.mockResolvedValue({ status: 200 })

    await service.snapshotOpenAllocations()

    const [, body] = post.mock.calls[0]
    expect(body.allocations).toHaveLength(1)
    expect(body.allocations[0]).toEqual(expect.objectContaining({ boxId: 'good' }))
  })

  // A network or server failure must not crash the cron: the next tick sends
  // fresher data regardless, so there is nothing to retry mid-tick.
  it('logs and does not throw when the push fails', async () => {
    const { service } = makeService([openPeriod()])
    post.mockRejectedValue({ isAxiosError: true, message: 'timeout', response: undefined })

    await expect(service.snapshotOpenAllocations()).resolves.toBeUndefined()
  })

  it('releases the lock even when the query throws', async () => {
    const { service, boxUsagePeriodRepository, redisLockProvider } = makeService([openPeriod()])
    boxUsagePeriodRepository.find.mockRejectedValue(new Error('database is down'))

    await expect(service.snapshotOpenAllocations()).rejects.toThrow('database is down')
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('snapshot-open-allocations')
  })
})
