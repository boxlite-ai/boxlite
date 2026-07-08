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

  async count(opts: { where: { boxId: string } }): Promise<number> {
    return this.rows.filter((r) => r.boxId === opts.where.boxId).length
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
})

describe('UsageService.handleBoxCreated', () => {
  let repo: FakeRepo
  let svc: UsageService

  beforeEach(() => {
    repo = new FakeRepo()
    svc = new UsageService(repo as never)
  })

  it('opens the first period from the CREATED snapshot when the ledger is empty', async () => {
    await svc.handleBoxCreated({ box: box(BoxState.STARTED) } as never)
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].kind).toBe('running')
  })

  it('ignores a stale CREATED snapshot when a racing STATE_UPDATED already ledgered the box', async () => {
    // STATE_UPDATED won the race: the box is already ledgered as running.
    await svc.applyTransition(box(BoxState.STARTED), BoxState.STARTED, new Date('2026-06-25T12:00:00Z'))

    // CREATED arrives late with its insert-time snapshot (CREATING → stopped);
    // applying it would close the live running period and flip it to stopped.
    await svc.handleBoxCreated({ box: box(BoxState.CREATING) } as never)

    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].kind).toBe('running')
    expect(repo.rows[0].periodEnd).toBeNull()
  })
})
