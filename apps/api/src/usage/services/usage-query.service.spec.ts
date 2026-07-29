/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { UsageQueryService } from './usage-query.service'

type RepositoryMock = {
  find: jest.Mock
}

function usagePeriod(overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod {
  return Object.assign(new BoxUsagePeriod(), {
    id: 'period-1',
    boxId: 'box-1',
    organizationId: 'org-1',
    startAt: new Date('2026-07-28T00:00:00.000Z'),
    endAt: new Date('2026-07-28T00:01:00.000Z'),
    cpu: 2,
    gpu: 0,
    gpuType: null,
    mem: 4,
    disk: 10,
    region: 'us',
    ...overrides,
  })
}

function archivedUsagePeriod(overrides: Partial<BoxUsagePeriodArchive> = {}): BoxUsagePeriodArchive {
  return Object.assign(new BoxUsagePeriodArchive(), usagePeriod(overrides as Partial<BoxUsagePeriod>), overrides)
}

function setup(activePeriods: BoxUsagePeriod[] = [], archivedPeriods: BoxUsagePeriodArchive[] = []) {
  const activeRepository: RepositoryMock = {
    find: jest.fn().mockResolvedValue(activePeriods),
  }
  const archiveRepository: RepositoryMock = {
    find: jest.fn().mockResolvedValue(archivedPeriods),
  }
  const manager = {
    getRepository: jest.fn((entity) => (entity === BoxUsagePeriod ? activeRepository : archiveRepository)),
  }
  const dataSource = {
    transaction: jest.fn(async (_isolation, callback) => callback(manager)),
  }
  const service = new UsageQueryService(dataSource as never)

  return { activeRepository, archiveRepository, dataSource, service }
}

describe('UsageQueryService', () => {
  it('reads one repeatable snapshot, clips open periods at now, and returns stable raw periods', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T00:00:45.000Z'))
    try {
      const active = usagePeriod({
        boxId: 'box-1',
        startAt: new Date('2026-07-28T00:00:30.000Z'),
        endAt: null,
        cpu: 4,
        gpu: 1,
        mem: 8,
        disk: 20,
      })
      const archived = archivedUsagePeriod({
        boxId: 'box-1',
        startAt: new Date('2026-07-27T23:59:30.000Z'),
        endAt: new Date('2026-07-28T00:00:30.000Z'),
      })
      const { dataSource, service } = setup([active], [archived])

      const result = await service.getBoxUsagePeriods(
        'org-1',
        'box-1',
        new Date('2026-07-28T00:00:00.000Z'),
        new Date('2026-07-28T00:01:00.000Z'),
      )

      expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function))
      expect(result).toEqual([
        {
          cpu: 2,
          diskGB: 10,
          endAt: '2026-07-28T00:00:30.000Z',
          gpu: 0,
          price: 0,
          ramGB: 4,
          startAt: '2026-07-28T00:00:00.000Z',
        },
        {
          cpu: 4,
          diskGB: 20,
          endAt: '2026-07-28T00:00:45.000Z',
          gpu: 1,
          price: 0,
          ramGB: 8,
          startAt: '2026-07-28T00:00:30.000Z',
        },
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  it('aggregates clipped resource-seconds and counts distinct boxes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T00:00:45.000Z'))
    try {
      const active = usagePeriod({
        boxId: 'box-2',
        startAt: new Date('2026-07-28T00:00:30.000Z'),
        endAt: null,
        cpu: 4,
        gpu: 1,
        mem: 8,
        disk: 20,
      })
      const archived = archivedUsagePeriod({
        boxId: 'box-1',
        startAt: new Date('2026-07-27T23:59:30.000Z'),
        endAt: new Date('2026-07-28T00:00:30.000Z'),
      })
      const { service } = setup([active], [archived])

      const result = await service.getAggregatedUsage(
        'org-1',
        new Date('2026-07-28T00:00:00.000Z'),
        new Date('2026-07-28T00:01:00.000Z'),
      )

      expect(result).toEqual({
        boxCount: 2,
        firstStart: '2026-07-28T00:00:00.000Z',
        lastEnd: '2026-07-28T00:00:45.000Z',
        totalCPUSeconds: 120,
        totalDiskGBSeconds: 600,
        totalGPUSeconds: 15,
        totalPrice: 0,
        totalRAMGBSeconds: 240,
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('returns exact per-box fields in deterministic box order', async () => {
    const archivedPeriods = [
      archivedUsagePeriod({ boxId: 'box-2' }),
      archivedUsagePeriod({ id: 'period-2', boxId: 'box-1' }),
    ]
    const { service } = setup([], archivedPeriods)

    const result = await service.getBoxUsage(
      'org-1',
      new Date('2026-07-28T00:00:00.000Z'),
      new Date('2026-07-28T00:01:00.000Z'),
    )

    expect(result.map((usage) => usage.boxId)).toEqual(['box-1', 'box-2'])
    expect(result[0]).toEqual({
      boxId: 'box-1',
      firstStart: '2026-07-28T00:00:00.000Z',
      lastEnd: '2026-07-28T00:01:00.000Z',
      totalCPUSeconds: 120,
      totalDiskGBSeconds: 600,
      totalGPUSeconds: 0,
      totalPrice: 0,
      totalRAMGBSeconds: 240,
    })
    expect(result[0]).not.toHaveProperty('boxCount')
  })

  it('filters chart input by region and returns average allocation per clipped UTC-day bucket', async () => {
    const archived = archivedUsagePeriod({
      startAt: new Date('2026-07-01T18:00:00.000Z'),
      endAt: new Date('2026-07-02T06:00:00.000Z'),
      cpu: 2,
      mem: 4,
      disk: 10,
      region: 'eu',
    })
    const { activeRepository, archiveRepository, service } = setup([], [archived])

    const result = await service.getUsageChart(
      'org-1',
      new Date('2026-07-01T12:00:00.000Z'),
      new Date('2026-07-02T12:00:00.000Z'),
      'eu',
    )

    expect(result).toEqual([
      {
        cpu: 1,
        cpuPrice: 0,
        diskGB: 5,
        diskPrice: 0,
        ramGB: 2,
        ramPrice: 0,
        time: '2026-07-01T12:00:00.000Z',
      },
      {
        cpu: 1,
        cpuPrice: 0,
        diskGB: 5,
        diskPrice: 0,
        ramGB: 2,
        ramPrice: 0,
        time: '2026-07-02T00:00:00.000Z',
      },
    ])
    expect(activeRepository.find.mock.calls[0][0].where).toEqual([
      expect.objectContaining({ region: 'eu' }),
      expect.objectContaining({ region: 'eu' }),
    ])
    expect(archiveRepository.find.mock.calls[0][0].where).toEqual(expect.objectContaining({ region: 'eu' }))
  })
})
