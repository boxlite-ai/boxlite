/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { usageEventKey } from '../usage-event'
import { UsageExportOutboxService } from './usage-export-outbox.service'

const period = (overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod =>
  Object.assign(new BoxUsagePeriod(), {
    id: 'period-1',
    organizationId: 'org-1',
    boxId: 'box-1',
    region: 'us',
    startAt: new Date('2026-08-01T00:00:00.000Z'),
    endAt: new Date('2026-08-01T01:00:00.000Z'),
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 10,
    ...overrides,
  })

/**
 * Captures the rows handed to the insert builder. Only the chain the service
 * actually uses is implemented, so a change of insert strategy fails loudly
 * here instead of silently recording nothing.
 */
const makeEntityManager = () => {
  const inserted: Partial<BoxUsageExportOutbox>[][] = []
  const builder = {
    insert: () => builder,
    into: () => builder,
    values: (rows: Partial<BoxUsageExportOutbox>[]) => {
      inserted.push(rows)
      return builder
    },
    orIgnore: () => builder,
    execute: async () => ({
      identifiers: inserted[inserted.length - 1].map((_row, index) => ({ id: `row-${index}` })),
    }),
  }
  return { entityManager: { createQueryBuilder: () => builder } as any, inserted }
}

/** Serves the archive one keyset page at a time and records how it was asked. */
const makeArchiveRepository = (pages: unknown[][]) => {
  const cursors: unknown[] = []
  const pageSizes: number[] = []
  let served = 0
  const builder: any = {
    orderBy: () => builder,
    addOrderBy: () => builder,
    take: (size: number) => {
      pageSizes.push(size)
      return builder
    },
    where: (_predicate: string, parameters: unknown) => {
      cursors.push(parameters)
      return builder
    },
    getMany: async () => pages[served++] ?? [],
  }
  return { archiveRepository: { createQueryBuilder: () => builder } as any, cursors, pageSizes }
}

const makeService = (enabled = true, archivePages: unknown[][] = [], backfillPageSize = 500) => {
  const configService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'usageExport.enabled':
          return enabled
        case 'usageExport.backfillPageSize':
          return backfillPageSize
        default:
          throw new Error(`usage-export-outbox.service.spec: unexpected config key "${key}"`)
      }
    }),
  }
  // backfill inserts through the repository's own manager rather than a caller's
  const { entityManager, inserted: backfilled } = makeEntityManager()
  const outboxRepository = {
    manager: entityManager,
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  }
  const { archiveRepository, cursors, pageSizes } = makeArchiveRepository(archivePages)

  const service = new UsageExportOutboxService(outboxRepository as any, archiveRepository as any, configService as any)

  return { service, outboxRepository, archiveRepository, backfilled, cursors, pageSizes }
}

describe('UsageExportOutboxService.enqueue', () => {
  it('writes nothing while export is disabled', async () => {
    const { service } = makeService(false)
    const { entityManager, inserted } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period()])).resolves.toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('records the event key, payload and denormalized columns', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()
    const usagePeriod = period()

    await service.enqueue(entityManager, [usagePeriod])

    expect(inserted[0]).toHaveLength(1)
    expect(inserted[0][0]).toEqual(
      expect.objectContaining({
        eventKey: usageEventKey(usagePeriod as any),
        status: UsageExportStatus.PENDING,
        schemaVersion: 1,
        organizationId: 'org-1',
        boxId: 'box-1',
        startAt: usagePeriod.startAt,
        endAt: usagePeriod.endAt,
      }),
    )
    expect(inserted[0][0].payload).toEqual(expect.objectContaining({ cpu: '2', mem: '4', disk: '10' }))
  })

  // Warm-pool boxes are capacity the platform holds for itself. createUsagePeriod
  // writes periods for them regardless, so the exporter is the only place the
  // exclusion can happen.
  it('excludes warm-pool periods', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()

    await service.enqueue(entityManager, [
      period({ organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION }),
      period({ id: 'period-2', boxId: 'box-2' }),
    ])

    expect(inserted[0]).toHaveLength(1)
    expect(inserted[0][0].boxId).toBe('box-2')
  })

  it('ignores periods that are still open', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period({ endAt: null })])).resolves.toBe(0)
    expect(inserted).toHaveLength(0)
  })

  // Two zero-duration periods for one box hash to one key. They carry no
  // billable time, so collapsing them is right — but both must not reach a
  // single INSERT, where only the conflict clause would save them.
  it('collapses periods that share an event key', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()
    const instant = new Date('2026-08-01T00:00:00.000Z')

    await service.enqueue(entityManager, [
      period({ id: 'a', startAt: instant, endAt: instant }),
      period({ id: 'b', startAt: instant, endAt: instant }),
    ])

    expect(inserted[0]).toHaveLength(1)
  })

  // Throwing would abort the caller's archive transaction, so one unparseable
  // period would wedge archiving — and therefore all export — indefinitely.
  it('blocks a malformed period without losing the rest of the batch', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()

    await service.enqueue(entityManager, [
      period({ id: 'bad', cpu: Number.NaN }),
      period({ id: 'good', boxId: 'box-2' }),
    ])

    expect(inserted[0]).toHaveLength(2)
    const blocked = inserted[0].find((row) => row.status === UsageExportStatus.BLOCKED)
    expect(blocked?.lastError).toMatch(/finite/)
    expect(blocked?.payload).toEqual(expect.objectContaining({ sourceId: 'bad', cpu: 'NaN' }))
    expect(inserted[0].some((row) => row.status === UsageExportStatus.PENDING)).toBe(true)
  })

  // Only malformed source data may be swallowed into a blocked row. A database
  // or programming fault has to keep failing loudly, or a broken exporter would
  // quietly mark real usage unexportable.
  it('rethrows faults that are not bad source data', async () => {
    const { service } = makeService()
    const entityManager = {
      createQueryBuilder: () => {
        throw new Error('connection terminated')
      },
    } as any

    await expect(service.enqueue(entityManager, [period()])).rejects.toThrow('connection terminated')
  })

  it('reports how many rows the insert actually created', async () => {
    const { service } = makeService()
    const { entityManager } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period(), period({ id: 'period-2', boxId: 'box-2' })])).resolves.toBe(
      2,
    )
  })
})

describe('UsageExportOutboxService.backfill', () => {
  const archived = (id: string, startAt: Date) => ({
    id,
    organizationId: 'org-1',
    boxId: `box-${id}`,
    region: 'us',
    startAt,
    endAt: new Date(startAt.getTime() + 3_600_000),
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 10,
  })

  const first = archived('a', new Date('2026-08-01T00:00:00.000Z'))
  const second = archived('b', new Date('2026-08-02T00:00:00.000Z'))

  it('walks every page until one comes back empty', async () => {
    const { service, backfilled, pageSizes } = makeService(true, [[first], [second], []], 1)

    await expect(service.backfill()).resolves.toEqual({ scanned: 2, enqueued: 2 })
    expect(backfilled).toHaveLength(2)
    expect(pageSizes).toEqual([1, 1, 1])
  })

  // startAt is not unique, so a cursor on it alone would either re-serve or skip
  // rows that share an instant. The id breaks the tie.
  it('advances a composite cursor built from the last row of each page', async () => {
    const { service, cursors } = makeService(true, [[first], [second], []], 1)

    await service.backfill()

    expect(cursors).toEqual([
      { startAt: first.startAt, id: 'a' },
      { startAt: second.startAt, id: 'b' },
    ])
  })

  it('asks for no cursor on the first page', async () => {
    const { service, cursors } = makeService(true, [[]], 500)

    await expect(service.backfill()).resolves.toEqual({ scanned: 0, enqueued: 0 })
    expect(cursors).toHaveLength(0)
  })

  it('excludes warm-pool periods it finds in the archive', async () => {
    const warmPool = { ...archived('c', new Date('2026-08-03T00:00:00.000Z')) }
    warmPool.organizationId = BOX_WARM_POOL_UNASSIGNED_ORGANIZATION
    const { service, backfilled } = makeService(true, [[warmPool], []], 500)

    await expect(service.backfill()).resolves.toEqual({ scanned: 1, enqueued: 0 })
    expect(backfilled).toHaveLength(0)
  })
})

describe('UsageExportOutboxService retention', () => {
  it('deletes only delivered rows older than the retention window', async () => {
    const { service, outboxRepository } = makeService()
    outboxRepository.delete.mockResolvedValue({ affected: 3 })

    await expect(service.pruneDelivered(30)).resolves.toBe(3)

    const [criteria] = outboxRepository.delete.mock.calls[0]
    expect(criteria.status).toBe(UsageExportStatus.DELIVERED)
    const cutoff = criteria.deliveredAt.value as Date
    expect(Math.abs(cutoff.getTime() - (Date.now() - 30 * 24 * 60 * 60 * 1000))).toBeLessThan(5_000)
  })

  it('reports no oldest pending row when the outbox is drained', async () => {
    const { service } = makeService()

    await expect(service.oldestPendingAt()).resolves.toBeNull()
  })

  it('reports the creation time of the oldest undelivered row', async () => {
    const { service, outboxRepository } = makeService()
    const createdAt = new Date('2026-08-01T00:00:00.000Z')
    outboxRepository.findOne.mockResolvedValue({ createdAt })

    await expect(service.oldestPendingAt()).resolves.toBe(createdAt)
    expect(outboxRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: UsageExportStatus.PENDING } }),
    )
  })
})
