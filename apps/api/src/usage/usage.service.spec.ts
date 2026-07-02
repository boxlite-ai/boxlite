/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageService } from './usage.service'

/**
 * Minimal in-memory stand-in for the TypeORM repository — exercises the
 * service's open/close orchestration without a database. `findOne` returns the
 * currently-open period (periodEnd == null) for a box; `save` upserts.
 */
class FakeRepo {
  rows: UsagePeriod[] = []

  create(obj: Partial<UsagePeriod>): UsagePeriod {
    return { ...obj } as UsagePeriod
  }

  async save(obj: UsagePeriod): Promise<UsagePeriod> {
    const now = new Date('2026-06-25T12:00:00Z')
    obj.createdAt ??= now
    obj.updatedAt = now
    if (!obj.id) {
      obj.id = `p${this.rows.length + 1}`
      this.rows.push(obj)
    }
    return obj
  }

  async findOne(opts: { where: { boxId: string } }): Promise<UsagePeriod | null> {
    const open = this.rows.filter((r) => r.boxId === opts.where.boxId && r.periodEnd == null)
    return open.length ? open[open.length - 1] : null
  }

  async find(opts: { where: { boxId: string }; order: { periodStart: 'ASC' } }): Promise<UsagePeriod[]> {
    return this.rows
      .filter((r) => r.boxId === opts.where.boxId)
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())
  }
}

function box(state: BoxState): Box {
  return { id: 'box-1', organizationId: 'org-1', region: 'r1', cpu: 2, mem: 4, disk: 10, state } as Box
}

describe('UsageService.applyTransition', () => {
  let repo: FakeRepo
  let svc: UsageService

  beforeEach(() => {
    repo = new FakeRepo()
    svc = new UsageService(repo as never)
  })

  it('opens a running period when a box starts', async () => {
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, new Date('2026-06-25T12:00:00Z'))
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]).toMatchObject({
      boxId: 'box-1',
      organizationId: 'org-1',
      kind: 'running',
      periodEnd: null,
      allocCpu: 2,
      allocMemGib: 4,
      allocDiskGib: 10,
    })
  })

  it('opens a disk-only stopped period when a box is created not-running', async () => {
    await svc.applyTransition(box(BoxState.CREATING), BoxState.CREATING, new Date('2026-06-25T12:00:00Z'))
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].kind).toBe('stopped')
  })

  it('closes running and opens stopped on stop (disk continues)', async () => {
    const t0 = new Date('2026-06-25T12:00:00Z')
    const t1 = new Date('2026-06-25T12:00:10Z')
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, t0)
    await svc.applyTransition(box(BoxState.STOPPED), BoxState.STOPPED, t1)

    const running = repo.rows.find((r) => r.kind === 'running')!
    const stopped = repo.rows.find((r) => r.kind === 'stopped')!
    expect(repo.rows).toHaveLength(2)
    expect(running.periodEnd).toEqual(t1) // closed at stop
    expect(stopped.periodEnd).toBeNull() // disk keeps running
  })

  it('does not fragment the ledger on a same-kind transition', async () => {
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, new Date('2026-06-25T12:00:00Z'))
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, new Date('2026-06-25T12:00:05Z'))
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].periodEnd).toBeNull()
  })

  it('closes the open period and opens nothing on destroy', async () => {
    const t0 = new Date('2026-06-25T12:00:00Z')
    const t1 = new Date('2026-06-25T12:00:10Z')
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, t0)
    await svc.applyTransition(box(BoxState.DESTROYED), BoxState.DESTROYED, t1)
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].periodEnd).toEqual(t1)
  })

  it('lists raw period rows in table order for dashboard inspection', async () => {
    const t0 = new Date('2026-06-25T12:00:00Z')
    const t1 = new Date('2026-06-25T12:00:10Z')
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, t0)
    await svc.applyTransition(box(BoxState.STOPPED), BoxState.STOPPED, t1)

    const rows = await svc.listBoxPeriods('box-1')

    expect(rows.map((row) => row.kind)).toEqual(['running', 'stopped'])
    expect(rows[0]).toMatchObject({
      boxId: 'box-1',
      organizationId: 'org-1',
      periodStart: '2026-06-25T12:00:00.000Z',
      periodEnd: '2026-06-25T12:00:10.000Z',
      allocCpu: 2,
      allocMemGib: 4,
      allocDiskGib: 10,
    })
    expect(rows[1].periodEnd).toBeNull()
  })
})
