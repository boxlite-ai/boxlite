/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../box/entities/box.entity'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../box/constants/box.constants'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxClass } from '../box/enums/box-class.enum'
import { RegionType } from '../region/enums/region-type.enum'
import { getMetadataArgsStorage } from 'typeorm'
import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageService } from './services/usage.service'

function matchesWhereValue(actual: unknown, expected: unknown): boolean {
  const op = expected as { _type?: string; _value?: unknown }
  if (op?._type === 'isNull') {
    return actual === null
  }
  if (op?._type === 'lessThan') {
    return actual instanceof Date && op._value instanceof Date && actual.getTime() < op._value.getTime()
  }
  if (op?._type === 'moreThan') {
    return actual instanceof Date && op._value instanceof Date && actual.getTime() > op._value.getTime()
  }
  if (op?._type === 'not') {
    return !matchesWhereValue(actual, op._value)
  }
  if (expected === null) {
    return actual === null
  }
  return actual === expected
}

class FakeUsagePeriodRepository {
  rows: UsagePeriod[] = []
  archivedRows: UsagePeriodArchive[] = []
  transactionOperations: string[] = []
  failNextSave: Error | null = null
  manager = {
    transaction: jest.fn(async (fn: (manager: FakeTransactionManager) => Promise<void>) => {
      await fn(new FakeTransactionManager(this))
    }),
  }

  create(input: Partial<UsagePeriod>): UsagePeriod {
    return input as UsagePeriod
  }

  async save(row: UsagePeriod | UsagePeriod[]): Promise<UsagePeriod | UsagePeriod[]> {
    if (this.failNextSave) {
      const err = this.failNextSave
      this.failNextSave = null
      throw err
    }

    if (Array.isArray(row)) {
      row.forEach((item) => this.upsert(item))
      return row
    }
    this.upsert(row)
    return row
  }

  async findOne(opts: { where: Partial<UsagePeriod> }): Promise<UsagePeriod | null> {
    const match = this.rows.find((row) => {
      return Object.entries(opts.where).every(([key, value]) => {
        return matchesWhereValue((row as unknown as Record<string, unknown>)[key], value)
      })
    })
    return match ?? null
  }

  async find(opts: {
    where?: Partial<UsagePeriod> | Partial<UsagePeriod>[]
    order?: { startAt?: 'ASC' | 'DESC' }
    take?: number
  }): Promise<UsagePeriod[]> {
    const where = Array.isArray(opts.where) ? opts.where : [opts.where ?? {}]
    const rows = this.rows.filter((row) =>
      where.some((whereItem) =>
        Object.entries(whereItem).every(([key, value]) => {
          return matchesWhereValue((row as unknown as Record<string, unknown>)[key], value)
        }),
      ),
    )

    if (opts.order?.startAt === 'DESC') {
      rows.sort((left, right) => right.startAt.getTime() - left.startAt.getTime())
    } else if (opts.order?.startAt === 'ASC') {
      rows.sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
    }

    return rows.slice(0, opts.take)
  }

  async delete(ids: string[]): Promise<void> {
    this.rows = this.rows.filter((row) => !ids.includes(row.id))
  }

  private upsert(row: UsagePeriod): void {
    if (!row.id) {
      row.id = `period-${this.rows.length + 1}`
      this.rows.push(row)
      return
    }

    const existing = this.rows.findIndex((item) => item.id === row.id)
    if (existing === -1) {
      this.rows.push(row)
    } else {
      this.rows[existing] = row
    }
  }
}

class FakeTransactionManager {
  constructor(private readonly periods: FakeUsagePeriodRepository) {}

  async find(
    _entity: typeof UsagePeriod,
    opts: {
      where?: Partial<UsagePeriod>
      order?: { startAt?: 'ASC' | 'DESC' }
      take?: number
    },
  ): Promise<UsagePeriod[]> {
    return this.periods.find(opts)
  }

  async save(
    entityOrInput: typeof UsagePeriod | typeof UsagePeriodArchive | UsagePeriod | UsagePeriod[] | UsagePeriodArchive[],
    input?: UsagePeriod | UsagePeriod[] | UsagePeriodArchive[],
  ): Promise<UsagePeriod | UsagePeriod[] | UsagePeriodArchive[]> {
    this.periods.transactionOperations.push('save')
    const value = input ?? (entityOrInput as UsagePeriod | UsagePeriod[] | UsagePeriodArchive[])
    if (!Array.isArray(value) || value[0] instanceof UsagePeriod) {
      return this.periods.save(value as UsagePeriod | UsagePeriod[])
    }

    const rows = value as UsagePeriodArchive[]
    rows.forEach((row) => {
      row.id = row.id ?? `archive-${this.periods.archivedRows.length + 1}`
      this.periods.archivedRows.push(row)
    })
    return rows
  }

  async delete(_entity: typeof UsagePeriod, ids: string[]): Promise<void> {
    this.periods.transactionOperations.push('delete')
    await this.periods.delete(ids)
  }
}

class FakeLockProvider {
  locks: string[] = []
  unlocks: string[] = []

  async waitForLock(): Promise<void> {}
  async lock(key: string): Promise<boolean> {
    this.locks.push(key)
    return true
  }
  async unlock(key: string): Promise<void> {
    this.unlocks.push(key)
  }
}

class FakeBoxRepository {
  boxes = new Map<string, Box>()

  async findOne(opts: { where: { id: string } }): Promise<Box | null> {
    return this.boxes.get(opts.where.id) ?? null
  }
}

class FakeRegionRepository {
  async findOne(): Promise<{ regionType: RegionType }> {
    return { regionType: RegionType.SHARED }
  }
}

function makeBox(state: BoxState, desiredState: BoxDesiredState = BoxDesiredState.STARTED): Box {
  return {
    id: 'box-1',
    organizationId: 'org-1',
    region: 'us',
    state,
    desiredState,
    cpu: 2,
    mem: 4,
    disk: 10,
    gpu: 1,
    class: BoxClass.SMALL,
  } as Box
}

describe('UsageService', () => {
  let periods: FakeUsagePeriodRepository
  let locks: FakeLockProvider
  let boxes: FakeBoxRepository
  let regions: FakeRegionRepository
  let service: UsageService

  beforeEach(() => {
    periods = new FakeUsagePeriodRepository()
    periods.archivedRows = []
    locks = new FakeLockProvider()
    boxes = new FakeBoxRepository()
    regions = new FakeRegionRepository()
    service = new UsageService(periods as never, locks as never, boxes as never, regions as never)
  })

  it('opens running periods and switches to disk-only periods when the box stops', async () => {
    const started = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    const stopping = makeBox(BoxState.STOPPING, BoxDesiredState.STOPPED)

    await service.handleBoxStateUpdate({ box: started, newState: BoxState.STARTED } as never)
    await service.handleBoxStateUpdate({ box: stopping, newState: BoxState.STOPPING } as never)

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0]).toMatchObject({ cpu: 2, endAt: expect.any(Date) })
    expect(periods.rows[1]).toMatchObject({ endAt: null, cpu: 0, mem: 0, gpu: 0, disk: 10 })
  })

  it('restarts the open period on every STARTED event', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)

    await service.handleBoxStateUpdate({ box, newState: BoxState.STARTED } as never)
    await service.handleBoxStateUpdate({ box, newState: BoxState.STARTED } as never)

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0]).toMatchObject({ cpu: 2, endAt: expect.any(Date) })
    expect(periods.rows[1]).toMatchObject({ cpu: 2, endAt: null })
  })

  it('rolls open periods older than 24 hours and reopens the same allocation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T00:00:00Z'))
    try {
      const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
      boxes.boxes.set(box.id, box)
      await service.handleBoxStateUpdate({ box, newState: BoxState.STARTED } as never)
      periods.rows[0].startAt = new Date('2026-07-06T00:00:00Z')

      await service.closeAndReopenUsagePeriods()

      expect(periods.rows).toHaveLength(2)
      expect(periods.rows[0].endAt).toEqual(new Date('2026-07-08T00:00:00Z'))
      expect(periods.rows[1]).toMatchObject({ cpu: 2, startAt: new Date('2026-07-08T00:00:00Z'), endAt: null })
      expect(periods.manager.transaction).toHaveBeenCalledTimes(1)
      expect(locks.locks).toContain('close-and-reopen-usage-periods')
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not roll over unassigned warm-pool periods', async () => {
    const warmPoolBox = {
      ...makeBox(BoxState.STARTED),
      organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
    } as Box
    boxes.boxes.set(warmPoolBox.id, warmPoolBox)
    await service.handleBoxStateUpdate({ box: warmPoolBox, newState: BoxState.STARTED } as never)
    periods.rows[0].startAt = new Date('2026-07-06T00:00:00Z')

    await service.closeAndReopenUsagePeriods()

    expect(periods.rows).toHaveLength(1)
    expect(periods.rows[0].endAt).toBeNull()
  })

  it('archives closed periods and removes them from the active table', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    await service.handleBoxStateUpdate({ box, newState: BoxState.STARTED } as never)
    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.DESTROYED, BoxDesiredState.DESTROYED),
      newState: BoxState.DESTROYED,
    } as never)
    const closedAt = periods.rows[0].endAt

    await service.archiveUsagePeriods()

    expect(periods.rows).toHaveLength(0)
    expect(periods.archivedRows).toHaveLength(1)
    expect(periods.archivedRows[0]).toMatchObject({
      boxId: 'box-1',
      organizationId: 'org-1',
      endAt: closedAt,
    })
    expect(locks.locks).toContain('archive-usage-periods')
  })

  it('propagates usage ledger failures from lifecycle event handlers and releases the Box lock', async () => {
    periods.failNextSave = new Error('database unavailable')

    await expect(
      service.handleBoxStateUpdate({ box: makeBox(BoxState.STARTED), newState: BoxState.STARTED } as never),
    ).rejects.toThrow('database unavailable')

    expect(locks.unlocks).toContain('usage-period-box-1')
  })

  it('archives closed periods in a single transaction', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    await service.handleBoxStateUpdate({ box, newState: BoxState.STARTED } as never)
    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.DESTROYED, BoxDesiredState.DESTROYED),
      newState: BoxState.DESTROYED,
    } as never)

    await service.archiveUsagePeriods()

    expect(periods.manager.transaction).toHaveBeenCalledTimes(1)
    expect(periods.rows).toHaveLength(0)
    expect(periods.archivedRows).toHaveLength(1)
    expect(periods.transactionOperations).toEqual(['delete', 'save'])
  })

  it('tracks active usage jobs for graceful shutdown', () => {
    expect((service as unknown as { activeJobs?: Set<string> }).activeJobs).toEqual(new Set())
  })
})

describe('usage period persistence', () => {
  it('uses the Box-specific table names', () => {
    const tables = getMetadataArgsStorage().tables

    expect(tables.find((table) => table.target === UsagePeriod)?.name).toBe('box_usage_period')
    expect(tables.find((table) => table.target === UsagePeriodArchive)?.name).toBe('box_usage_period_archive')

    const columns = getMetadataArgsStorage().columns.filter((column) => column.target === UsagePeriod)
    expect(columns.map((column) => column.propertyName)).toEqual(expect.arrayContaining(['boxClass', 'regionType']))
  })
})
