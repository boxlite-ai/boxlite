/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../box/entities/box.entity'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageService } from './usage.service'

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

  async save(_entity: typeof UsagePeriodArchive, rows: UsagePeriodArchive[]): Promise<UsagePeriodArchive[]> {
    rows.forEach((row) => {
      row.id = row.id ?? `archive-${this.periods.archivedRows.length + 1}`
      this.periods.archivedRows.push(row)
    })
    return rows
  }

  async delete(_entity: typeof UsagePeriod, ids: string[]): Promise<void> {
    await this.periods.delete(ids)
  }
}

class FakeArchiveRepository {
  rows: UsagePeriodArchive[] = []

  create(input: Partial<UsagePeriodArchive>): UsagePeriodArchive {
    return input as UsagePeriodArchive
  }

  async find(opts: {
    where?: Partial<UsagePeriodArchive> | Partial<UsagePeriodArchive>[]
    order?: { startAt?: 'ASC' | 'DESC' }
    take?: number
  }): Promise<UsagePeriodArchive[]> {
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

  async save(rows: UsagePeriodArchive[]): Promise<UsagePeriodArchive[]> {
    rows.forEach((row) => {
      row.id = row.id ?? `archive-${this.rows.length + 1}`
      this.rows.push(row)
    })
    return rows
  }
}

class FakeLockProvider {
  unlocks: string[] = []

  async waitForLock(): Promise<void> {}
  async lock(): Promise<boolean> {
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
  } as Box
}

describe('UsageService', () => {
  let periods: FakeUsagePeriodRepository
  let archives: FakeArchiveRepository
  let locks: FakeLockProvider
  let boxes: FakeBoxRepository
  let service: UsageService

  beforeEach(() => {
    periods = new FakeUsagePeriodRepository()
    periods.archivedRows = []
    archives = new FakeArchiveRepository()
    locks = new FakeLockProvider()
    boxes = new FakeBoxRepository()
    service = new UsageService(periods as never, archives as never, locks as never, boxes as never)
  })

  it('opens running periods and switches to disk-only periods when the box stops', async () => {
    const started = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    const stopped = makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED)

    await service.applyTransition(started, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.applyTransition(stopped, BoxState.STOPPED, BoxDesiredState.STOPPED, new Date('2026-07-08T00:00:10Z'))

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0]).toMatchObject({ kind: 'running', endAt: new Date('2026-07-08T00:00:10Z') })
    expect(periods.rows[1]).toMatchObject({ kind: 'stopped', endAt: null, cpu: 0, mem: 0, gpu: 0, disk: 10 })
  })

  it('does not fragment the open period on same-kind transitions', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)

    await service.applyTransition(box, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.applyTransition(box, BoxState.RESIZING, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:05Z'))

    expect(periods.rows).toHaveLength(1)
    expect(periods.rows[0]).toMatchObject({ kind: 'running', endAt: null })
  })

  it('reopens the period when billable resources change without changing lifecycle kind', async () => {
    const started = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    const resized = {
      ...started,
      cpu: 4,
      mem: 8,
      disk: 20,
      gpu: 2,
    } as Box

    await service.applyTransition(started, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.applyTransition(resized, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:30Z'))

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0]).toMatchObject({
      kind: 'running',
      endAt: new Date('2026-07-08T00:00:30Z'),
      cpu: 2,
      mem: 4,
      disk: 10,
      gpu: 1,
    })
    expect(periods.rows[1]).toMatchObject({
      kind: 'running',
      endAt: null,
      cpu: 4,
      mem: 8,
      disk: 20,
      gpu: 2,
    })
  })

  it('reopens the period under the new organization when a box is reassigned', async () => {
    const started = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    const reassigned = {
      ...started,
      organizationId: 'org-2',
    } as Box

    await service.applyTransition(started, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.handleBoxOrganizationUpdated({
      box: reassigned,
      oldOrganizationId: 'org-1',
      newOrganizationId: 'org-2',
    } as never)

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0]).toMatchObject({
      kind: 'running',
      organizationId: 'org-1',
      endAt: expect.any(Date),
    })
    expect(periods.rows[1]).toMatchObject({
      kind: 'running',
      organizationId: 'org-2',
      endAt: null,
    })
  })

  it('returns a raw organization metering view across active and archived periods', async () => {
    periods.rows.push({
      id: 'period-open',
      boxId: 'box-1',
      organizationId: 'org-1',
      region: 'us',
      startAt: new Date('2026-07-08T00:00:00Z'),
      endAt: null,
      kind: 'running',
      cpu: 2,
      mem: 4,
      disk: 10,
      gpu: 1,
      actualCpuSeconds: null,
      actualRssAvgBytes: null,
      actualRssPeakBytes: null,
      sampleCount: null,
    } as UsagePeriod)
    archives.rows.push({
      id: 'archive-1',
      sourcePeriodId: 'period-closed',
      boxId: 'box-2',
      organizationId: 'org-1',
      region: 'us',
      startAt: new Date('2026-07-07T23:00:00Z'),
      endAt: new Date('2026-07-08T00:00:00Z'),
      kind: 'stopped',
      cpu: 0,
      mem: 0,
      disk: 20,
      gpu: 0,
      actualCpuSeconds: null,
      actualRssAvgBytes: null,
      actualRssPeakBytes: null,
      sampleCount: null,
    } as UsagePeriodArchive)

    const view = await service.getOrganizationMeteringView('org-1', {
      from: new Date('2026-07-07T23:00:00Z'),
      to: new Date('2026-07-08T01:00:00Z'),
      limit: 10,
    })

    expect(view.organizationId).toBe('org-1')
    expect(view.activePeriods).toHaveLength(1)
    expect(view.archivedPeriods).toHaveLength(1)
    expect(view.totals).toEqual({
      cpuSeconds: 7200,
      memGibSeconds: 14400,
      diskGibSeconds: 108000,
      gpuSeconds: 3600,
    })
    expect(view.activePeriods[0]).toMatchObject({
      source: 'usage_period',
      active: true,
      durationSeconds: 3600,
    })
    expect(view.archivedPeriods[0]).toMatchObject({
      source: 'usage_period_archive',
      active: false,
      durationSeconds: 3600,
    })
  })

  it('ignores stale transitions that arrive before the open period start', async () => {
    const warn = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation()
    const started = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    const stopped = makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED)

    await service.applyTransition(started, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:10Z'))
    await service.applyTransition(stopped, BoxState.STOPPED, BoxDesiredState.STOPPED, new Date('2026-07-08T00:00:05Z'))

    expect(periods.rows).toHaveLength(1)
    expect(periods.rows[0]).toMatchObject({ kind: 'running', startAt: new Date('2026-07-08T00:00:10Z'), endAt: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring stale usage transition'))
  })

  it('rolls open periods older than 24 hours and reopens the same billable kind', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    boxes.boxes.set(box.id, box)
    await service.applyTransition(box, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-06T00:00:00Z'))

    await service.closeAndReopenUsagePeriods(new Date('2026-07-08T00:00:00Z'))

    expect(periods.rows).toHaveLength(2)
    expect(periods.rows[0].endAt).toEqual(new Date('2026-07-08T00:00:00Z'))
    expect(periods.rows[1]).toMatchObject({ kind: 'running', startAt: new Date('2026-07-08T00:00:00Z'), endAt: null })
  })

  it('archives closed periods and removes them from the active table', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    await service.applyTransition(box, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.applyTransition(
      makeBox(BoxState.DESTROYED, BoxDesiredState.DESTROYED),
      BoxState.DESTROYED,
      BoxDesiredState.DESTROYED,
      new Date('2026-07-08T00:00:10Z'),
    )

    await service.archiveUsagePeriods()

    expect(periods.rows).toHaveLength(0)
    expect(periods.archivedRows).toHaveLength(1)
    expect(periods.archivedRows[0]).toMatchObject({
      boxId: 'box-1',
      organizationId: 'org-1',
      endAt: new Date('2026-07-08T00:00:10Z'),
    })
  })

  it('does not propagate usage ledger failures from lifecycle event handlers', async () => {
    jest.spyOn((service as unknown as { logger: { error: jest.Mock } }).logger, 'error').mockImplementation()
    periods.failNextSave = new Error('database unavailable')

    await expect(service.handleBoxCreated({ box: makeBox(BoxState.STARTED, BoxDesiredState.STARTED) } as never)).resolves.toBeUndefined()

    expect(locks.unlocks).toContain('usage-period:box-1')
  })

  it('archives closed periods in a single transaction', async () => {
    const box = makeBox(BoxState.STARTED, BoxDesiredState.STARTED)
    await service.applyTransition(box, BoxState.STARTED, BoxDesiredState.STARTED, new Date('2026-07-08T00:00:00Z'))
    await service.applyTransition(
      makeBox(BoxState.DESTROYED, BoxDesiredState.DESTROYED),
      BoxState.DESTROYED,
      BoxDesiredState.DESTROYED,
      new Date('2026-07-08T00:00:10Z'),
    )

    await service.archiveUsagePeriods()

    expect(periods.manager.transaction).toHaveBeenCalledTimes(1)
    expect(periods.rows).toHaveLength(0)
    expect(periods.archivedRows).toHaveLength(1)
    expect(archives.rows).toHaveLength(0)
  })
})
