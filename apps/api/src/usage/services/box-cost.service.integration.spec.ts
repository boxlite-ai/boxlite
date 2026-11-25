/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { AddBoxUsageExportOutbox1786100000000 } from '../../migrations/pre-deploy/1786100000000-add-box-usage-export-outbox-migration'
import { AddUndeliveredUsageBoxIndex1795564800000 } from '../../migrations/pre-deploy/1795564800000-add-undelivered-usage-box-index-migration'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxCostService } from './box-cost.service'
import { UsageExportOutboxService } from './usage-export-outbox.service'
import { UsageService } from './usage.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

const boxId = 'aB3cD4eF5gH6'
const organizationId = randomUUID()
const start = new Date('2026-11-25T10:00:00.000Z')
const end = new Date('2026-11-25T10:00:15.000Z')
const line = {
  item: 'cpu',
  quantity: '15',
  unit: 'vcpu_second',
  amount_usd: '0.00021',
  start: start.toISOString(),
  end: end.toISOString(),
}
const priced = { lines: [line], totalUsd: '0.00021' }
const unpriced = { lines: [], totalUsd: null }

// The migrations build the usage tables, and the box table holds the columns the read uses.
describeIfDatabase('BoxCostService (integration, real Postgres)', () => {
  let db: DataSource
  let schema: string
  let periods: Repository<BoxUsagePeriod>
  let price: jest.Mock
  let lock: jest.Mock
  let service: BoxCostService

  beforeAll(async () => {
    schema = `box_cost_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [BoxUsagePeriod, BoxUsagePeriodArchive, BoxUsageExportOutbox],
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(`CREATE TABLE box (id varchar PRIMARY KEY, "organizationId" uuid NOT NULL, state varchar NOT NULL,
      "desiredState" varchar NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL)`)
    const runner = db.createQueryRunner()
    try {
      await new AddBoxUsagePeriods1785250000000().up(runner)
      await new AddBoxUsageExportOutbox1786100000000().up(runner)
      await new AddUndeliveredUsageBoxIndex1795564800000().up(runner)
    } finally {
      await runner.release()
    }
    periods = db.getRepository(BoxUsagePeriod)
  })

  afterAll(async () => {
    if (!db?.isInitialized) return
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await db.destroy()
  })

  beforeEach(async () => {
    await db.query('TRUNCATE box, box_usage_periods, box_usage_periods_archive, box_usage_export_outbox')
    price = jest.fn().mockResolvedValue(priced)
    lock = jest.fn().mockResolvedValue(true)
    service = new BoxCostService(periods, { price } as never, { lock } as never)
  })

  const addBox = (state = BoxState.DESTROYED, minutesAgo = 11, desiredState = BoxDesiredState.DESTROYED) =>
    db.query(`INSERT INTO box VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`, [
      boxId,
      organizationId,
      state,
      desiredState,
      start,
      minutesAgo,
    ])

  const addPeriod = (overrides: Partial<BoxUsagePeriod> = {}) =>
    periods.save(
      periods.create({
        boxId,
        organizationId,
        region: 'us',
        cpu: 1,
        gpu: 0,
        mem: 2,
        disk: 10,
        startAt: start,
        endAt: end,
        ...overrides,
      }),
    )

  // The production archive job, so outbox rows have the shape that ships.
  const archive = () =>
    new UsageService(
      periods,
      {
        acquireLease: async () => ({ signal: new AbortController().signal, release: async () => undefined }),
      } as never,
      {} as never,
      new UsageExportOutboxService(db.getRepository(BoxUsageExportOutbox), { get: () => true } as never),
      {} as never,
    )

  const setStatus = (status: UsageExportStatus) => db.query('UPDATE box_usage_export_outbox SET status = $1', [status])

  const archivePeriod = async (status: UsageExportStatus, overrides: Partial<BoxUsagePeriod> = {}) => {
    await addPeriod(overrides)
    await archive().archiveUsagePeriods()
    await setStatus(status)
  }

  const getCost = () => service.getCost(boxId, organizationId)

  it.each<[string, () => Promise<unknown>]>([
    ['open', () => addPeriod({ endAt: null })],
    ['closed but unarchived', () => addPeriod()],
    ['pending', () => archivePeriod(UsageExportStatus.PENDING)],
    ['blocked', () => archivePeriod(UsageExportStatus.BLOCKED)],
  ])('stays accruing up to the start of %s usage, with or without the box row', async (_name, seed) => {
    await seed()
    await expect(getCost()).resolves.toMatchObject({ status: 'accruing', as_of: start.toISOString() })
    await addBox()
    await expect(getCost()).resolves.toMatchObject({ status: 'accruing', as_of: start.toISOString() })
    expect(price.mock.calls).toEqual(Array(2).fill([organizationId, boxId, start]))
  })

  it('is final once every period is delivered, as of the check', async () => {
    await addBox()
    await archivePeriod(UsageExportStatus.DELIVERED)
    const before = Date.now()
    const cost = await getCost()
    expect(cost).toEqual({
      box_id: boxId,
      status: 'final',
      source: 'calculated',
      total_usd: '0.00021',
      lines: [line],
      as_of: expect.any(String),
    })
    expect(Math.abs(Date.parse(cost.as_of) - before)).toBeLessThan(60_000)
  })

  it.each<[BoxState, BoxDesiredState, string]>([
    [BoxState.STARTED, BoxDesiredState.DESTROYED, 'final'],
    [BoxState.DESTROYING, BoxDesiredState.DESTROYED, 'final'],
    [BoxState.DESTROYED, BoxDesiredState.DESTROYED, 'final'],
    [BoxState.ERROR, BoxDesiredState.DESTROYED, 'final'],
    [BoxState.ERROR, BoxDesiredState.STARTED, 'accruing'],
    [BoxState.CREATING, BoxDesiredState.STARTED, 'accruing'],
    [BoxState.STOPPED, BoxDesiredState.STOPPED, 'accruing'],
    [BoxState.STARTED, BoxDesiredState.STARTED, 'accruing'],
  ])('reads %s (desired %s) as %s', async (state, desiredState, status) => {
    await addBox(state, 0, desiredState)
    await expect(getCost()).resolves.toMatchObject({ status })
  })

  it('stays final with unchanged figures while a failed deletion is retried', async () => {
    price.mockResolvedValue(unpriced)
    await addBox(BoxState.ERROR, 60)
    const first = await getCost()
    for (const state of [BoxState.DESTROYING, BoxState.ERROR, BoxState.DESTROYED]) {
      await db.query('UPDATE box SET state = $1, "updatedAt" = now()', [state])
      await expect(getCost()).resolves.toEqual({ ...first, as_of: expect.any(String) })
    }
  })

  it('has no total while accruing with nothing priced, and one zero line when final', async () => {
    price.mockResolvedValue(unpriced)
    await addBox(BoxState.STARTED, 0, BoxDesiredState.STARTED)
    await expect(getCost()).resolves.toMatchObject({ status: 'accruing', total_usd: null, lines: [] })
    await db.query('DELETE FROM box')
    await addBox()
    await expect(getCost()).resolves.toMatchObject({
      status: 'final',
      total_usd: '0',
      lines: [{ item: 'cpu', quantity: '0', unit: 'vcpu_second', amount_usd: '0', start: start.toISOString() }],
    })
  })

  it('stays readable after the box row is removed', async () => {
    await expect(getCost()).resolves.toMatchObject({ status: 'final', total_usd: '0.00021' })
  })

  it('answers 404 for an unknown box and for another organization', async () => {
    price.mockResolvedValue(unpriced)
    await expect(getCost()).rejects.toMatchObject({ status: 404 })
    await addBox()
    await addPeriod()
    await expect(service.getCost(boxId, randomUUID())).rejects.toMatchObject({ status: 404 })
  })

  it.each(['my-box', 'aB3cD4eF5gH', 'aB3cD4eF5gH67', '../../secrets'])('answers 404 for %s', async (id) => {
    await expect(service.getCost(id, organizationId)).rejects.toMatchObject({ status: 404 })
    expect(price).not.toHaveBeenCalled()
  })

  it('ignores warm pool usage, also when asked as the warm pool', async () => {
    await addBox()
    await addPeriod({ organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION, endAt: null })
    await expect(getCost()).resolves.toMatchObject({ status: 'final' })
    await expect(service.getCost(boxId, BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)).rejects.toMatchObject({ status: 404 })
  })

  it('counts no usage when a blocked row has no readable start', async () => {
    await addBox()
    await archivePeriod(UsageExportStatus.BLOCKED)
    await db.query(`UPDATE box_usage_export_outbox SET payload = payload || '{"startAt":"Invalid Date"}'`)
    await expect(getCost()).resolves.toMatchObject({ status: 'accruing', as_of: '1970-01-01T00:00:00.000Z' })
  })

  it('reports usage delivered during the price read in the next read', async () => {
    await addBox()
    await archivePeriod(UsageExportStatus.PENDING)
    price.mockImplementationOnce(async () => {
      await setStatus(UsageExportStatus.DELIVERED)
      return unpriced
    })
    await expect(getCost()).resolves.toMatchObject({ status: 'accruing', total_usd: null })
    await expect(getCost()).resolves.toMatchObject({ status: 'final', total_usd: '0.00021' })
  })

  it('never reads final while archiving moves the period', async () => {
    await addBox()
    for (let round = 0; round < 20; round += 1) {
      await addPeriod({ startAt: new Date(start.getTime() + round) })
      let moving = true
      const move = archive()
        .archiveUsagePeriods()
        .finally(() => (moving = false))
      while (moving) await expect(getCost()).resolves.toMatchObject({ status: 'accruing' })
      await move
      expect(await periods.count()).toBe(0)
      await expect(getCost()).resolves.toMatchObject({ status: 'accruing' })
      await db.query('TRUNCATE box_usage_export_outbox')
    }
  })

  it('propagates a failed price read instead of a zero cost', async () => {
    await addBox()
    price.mockRejectedValue(new Error('unavailable'))
    await expect(getCost()).rejects.toThrow('unavailable')
  })

  it('finds undelivered rows of a box through the partial index', async () => {
    const plan = await db.transaction(async (manager) => {
      await manager.query('SET LOCAL enable_seqscan = off')
      return manager.query(`EXPLAIN SELECT 1 FROM box_usage_export_outbox o
        WHERE o."payload"->>'boxId' = 'x' AND o."status" <> 'delivered'`)
    })
    expect(JSON.stringify(plan)).toContain('box_usage_export_outbox_undelivered_box_idx')
  })

  it('reapplies and reverts the index migration', async () => {
    const migration = new AddUndeliveredUsageBoxIndex1795564800000()
    const runner = db.createQueryRunner()
    const exists = async () =>
      (await runner.query(`SELECT to_regclass('box_usage_export_outbox_undelivered_box_idx') AS index`))[0].index
    try {
      await migration.up(runner)
      await migration.down(runner)
      await migration.down(runner)
      expect(await exists()).toBeNull()
      await migration.up(runner)
      expect(await exists()).not.toBeNull()
    } finally {
      await runner.release()
    }
  })

  describe('overdue report', () => {
    let logged: jest.SpyInstance

    beforeEach(() => {
      logged = jest.spyOn((service as never as { logger: { error: () => void } }).logger, 'error').mockReturnValue()
    })

    it.each<[string, boolean, () => Promise<unknown>]>([
      ['an ended box with blocked usage', true, async () => (await addBox(BoxState.DESTROYED, 16), seedBlocked())],
      ['a removed box with blocked usage', true, () => seedBlocked()],
      ['a box that ended recently', false, async () => (await addBox(BoxState.DESTROYED, 14), seedBlocked())],
      ['a running box', false, async () => (await addBox(BoxState.STARTED, 60, BoxDesiredState.STARTED), addPeriod())],
      ['delivered usage', false, () => archivePeriod(UsageExportStatus.DELIVERED)],
      ['warm pool usage', false, () => addPeriod({ organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION })],
    ])('%s: %s', async (_name, isOverdue, seed) => {
      await seed()
      await service.reportOverdue()
      expect(logged).toHaveBeenCalledTimes(isOverdue ? 1 : 0)
      if (isOverdue) expect(logged).toHaveBeenCalledWith(expect.stringContaining(boxId))
    })

    it('runs on one instance at a time', async () => {
      lock.mockResolvedValue(false)
      await seedBlocked()
      await service.reportOverdue()
      expect(logged).not.toHaveBeenCalled()
    })

    function seedBlocked() {
      return archivePeriod(UsageExportStatus.BLOCKED)
    }
  })
})
