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
    // `raw` is RETURNING, which is what the service counts — a conflict-skipped
    // row appears in the values but not here.
    execute: async () => ({
      raw: inserted[inserted.length - 1].map((row) => ({ eventKey: row.eventKey })),
    }),
  }
  return { entityManager: { createQueryBuilder: () => builder } as any, inserted }
}

const makeService = (enabled = true) => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'usageExport.enabled') {
        return enabled
      }
      throw new Error(`usage-export-outbox.service.spec: unexpected config key "${key}"`)
    }),
  }
  const outboxRepository = { delete: jest.fn().mockResolvedValue({ affected: 0 }) }

  const service = new UsageExportOutboxService(outboxRepository as any, configService as any)

  return { service, outboxRepository }
}

describe('UsageExportOutboxService.enqueue', () => {
  it('writes nothing while export is disabled', async () => {
    const { service } = makeService(false)
    const { entityManager, inserted } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period()])).resolves.toBe(0)
    expect(inserted).toHaveLength(0)
  })

  // The payload is the whole message; nothing about the usage is duplicated
  // into columns beside it.
  it('records only the event key, payload and queue state', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()
    const usagePeriod = period()

    await service.enqueue(entityManager, [usagePeriod])

    expect(inserted[0]).toHaveLength(1)
    expect(Object.keys(inserted[0][0]).sort()).toEqual(['eventKey', 'payload', 'status'])
    expect(inserted[0][0]).toEqual(
      expect.objectContaining({
        eventKey: usageEventKey(usagePeriod as any),
        status: UsageExportStatus.PENDING,
      }),
    )
    expect(inserted[0][0].payload).toEqual(
      expect.objectContaining({ schemaVersion: 1, boxId: 'box-1', cpu: '2', mem: '4', disk: '10' }),
    )
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
    expect((inserted[0][0].payload as any).boxId).toBe('box-2')
  })

  it('writes nothing when every period in the batch is warm-pool', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()

    await expect(
      service.enqueue(entityManager, [period({ organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION })]),
    ).resolves.toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('ignores periods that are still open', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period({ endAt: null })])).resolves.toBe(0)
    expect(inserted).toHaveLength(0)
  })

  // Throwing would abort the caller's archive transaction, which covers every
  // closed period in one batch ordered by startAt — so one unparseable row
  // would sort early, sit in every batch, and wedge archiving forever.
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

  // Only bad source data may become a blocked row. This has to fail from inside
  // the per-period conversion, where the guard lives — a throw from the insert
  // builder happens after the mapping and would pass whether the guard exists
  // or not, leaving a swallowed database fault as permanently unexportable usage.
  it('rethrows a fault raised while converting a period', async () => {
    const { service } = makeService()
    const { entityManager, inserted } = makeEntityManager()
    // Fails once, during conversion, and reads normally afterwards. A getter
    // that always threw would throw again inside the diagnostic snapshot, so
    // the test would still see an exception with the guard deleted and would
    // pass for the wrong reason.
    let failed = false
    const exploding = Object.defineProperty(period(), 'cpu', {
      get() {
        if (failed) {
          return 2
        }
        failed = true
        throw new Error('column decode failed')
      },
    })

    await expect(service.enqueue(entityManager, [exploding])).rejects.toThrow('column decode failed')
    expect(inserted).toHaveLength(0)
  })

  it('reports how many rows the insert actually created', async () => {
    const { service } = makeService()
    const { entityManager } = makeEntityManager()

    await expect(service.enqueue(entityManager, [period(), period({ id: 'period-2', boxId: 'box-2' })])).resolves.toBe(
      2,
    )
  })
})

describe('UsageExportOutboxService.pruneDelivered', () => {
  it('deletes only delivered rows older than the retention window', async () => {
    const { service, outboxRepository } = makeService()
    outboxRepository.delete.mockResolvedValue({ affected: 3 })

    await expect(service.pruneDelivered(30)).resolves.toBe(3)

    const [criteria] = outboxRepository.delete.mock.calls[0]
    expect(criteria.status).toBe(UsageExportStatus.DELIVERED)
    const cutoff = criteria.deliveredAt.value as Date
    expect(Math.abs(cutoff.getTime() - (Date.now() - 30 * 24 * 60 * 60 * 1000))).toBeLessThan(5_000)
  })
})
