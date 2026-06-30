/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Real-Postgres integration test for the MVP usage-timing ledger. Skipped by
 * default (no DB in CI); run against a local Postgres with:
 *
 *   RUN_DB_IT=1 npx nx test api --testPathPatterns=usage.integration --skip-nx-cache
 *
 * Runs the MVP migration, then drives a box lifecycle through UsageService and
 * checks the segments open/close correctly + getBoxUsage computes alloc-seconds.
 */

import { DataSource, IsNull } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { Migration1782600000000 } from '../migrations/pre-deploy/1782600000000-migration'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageService } from './usage.service'

const dbDescribe = process.env.RUN_DB_IT ? describe : describe.skip

const box = (state: BoxState): Box =>
  ({ id: 'box-it', organizationId: 'org-it', region: 'r1', cpu: 2, mem: 4, disk: 10, state }) as Box

dbDescribe('MVP usage timing — real Postgres', () => {
  let ds: DataSource
  let svc: UsageService

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5440),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_DATABASE ?? 'usage_it',
      entities: [UsagePeriod],
      synchronize: false,
    })
    await ds.initialize()
    const qr = ds.createQueryRunner()
    await qr.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await qr.query(`DROP TABLE IF EXISTS "usage_period" CASCADE`)
    await new Migration1782600000000().up(qr)
    await qr.release()
    svc = new UsageService(ds.getRepository(UsagePeriod))
  }, 60000)

  afterAll(async () => {
    if (!ds?.isInitialized) return
    const qr = ds.createQueryRunner()
    await qr.query(`DROP TABLE IF EXISTS "usage_period" CASCADE`)
    await qr.release()
    await ds.destroy()
  })

  it('builds running→stopped segments across a box lifecycle and aggregates alloc-seconds', async () => {
    const t0 = new Date('2026-06-25T12:00:00Z')
    const t1 = new Date('2026-06-25T12:00:10Z') // +10s running
    const t2 = new Date('2026-06-25T12:00:30Z') // +20s stopped

    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, t0) // open running
    await svc.applyTransition(box(BoxState.STOPPED), BoxState.STOPPED, t1) // close running, open stopped
    await svc.applyTransition(box(BoxState.DESTROYED), BoxState.DESTROYED, t2) // close stopped

    const rows = await ds.getRepository(UsagePeriod).find({ where: { boxId: 'box-it' }, order: { periodStart: 'ASC' } })
    expect(rows.map((r) => [r.kind, r.periodEnd !== null])).toEqual([
      ['running', true], // running, closed at t1
      ['stopped', true], // stopped, closed at t2
    ])

    // running 10s → cpu 2×10, ram 4×10; disk continuous across both 30s → 10×30
    const usage = await svc.getBoxUsage('box-it', t0, t2)
    expect(usage).toEqual({
      boxId: 'box-it',
      totalCPUSeconds: 20,
      totalRAMGBSeconds: 40,
      totalDiskGBSeconds: 300,
      totalGPUSeconds: 0,
    })
  })

  it('keeps at most one open segment per box (close-before-open guard)', async () => {
    const b = (state: BoxState): Box => ({ ...box(state), id: 'box-guard' }) as Box
    await svc.applyTransition(b(BoxState.STARTED), BoxState.STARTED, new Date('2026-06-25T13:00:00Z'))
    await svc.applyTransition(b(BoxState.STOPPED), BoxState.STOPPED, new Date('2026-06-25T13:00:10Z'))

    // mid-lifecycle (running closed, stopped open) → exactly ONE open segment, not two
    const open = await ds.getRepository(UsagePeriod).find({ where: { boxId: 'box-guard', periodEnd: IsNull() } })
    expect(open).toHaveLength(1)
    expect(open[0].kind).toBe('stopped')
  })
})
