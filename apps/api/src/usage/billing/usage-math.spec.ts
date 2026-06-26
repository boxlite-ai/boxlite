/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { aggregatePeriods, billingPeriodKind, planReconcileClose, planTransition, BillablePeriod } from './usage-math'

describe('planTransition', () => {
  it('first STARTED opens a running period', () => {
    expect(planTransition(null, BoxState.STARTED)).toEqual({ closeOpen: false, openKind: 'running' })
  })
  it('running → STOPPED closes running, opens stopped (disk continues)', () => {
    expect(planTransition('running', BoxState.STOPPED)).toEqual({ closeOpen: true, openKind: 'stopped' })
  })
  it('stopped → STARTED closes stopped, opens running', () => {
    expect(planTransition('stopped', BoxState.STARTED)).toEqual({ closeOpen: true, openKind: 'running' })
  })
  it('running → STARTED (same kind) is a no-op, no fragmentation', () => {
    expect(planTransition('running', BoxState.STARTED)).toEqual({ closeOpen: false, openKind: null })
  })
  it('running → DESTROYED closes running, opens nothing', () => {
    expect(planTransition('running', BoxState.DESTROYED)).toEqual({ closeOpen: true, openKind: null })
  })
  it('no open period → DESTROYED is a no-op', () => {
    expect(planTransition(null, BoxState.DESTROYED)).toEqual({ closeOpen: false, openKind: null })
  })
})

describe('billingPeriodKind', () => {
  it('STARTED → running (cpu+ram+disk bill)', () => {
    expect(billingPeriodKind(BoxState.STARTED)).toBe('running')
  })
  it('STOPPED → stopped (disk still on disk, no cpu/ram)', () => {
    expect(billingPeriodKind(BoxState.STOPPED)).toBe('stopped')
  })
  it('ARCHIVED → stopped (rootfs retained)', () => {
    expect(billingPeriodKind(BoxState.ARCHIVED)).toBe('stopped')
  })
  it('CREATING → stopped (rootfs exists, not running yet)', () => {
    expect(billingPeriodKind(BoxState.CREATING)).toBe('stopped')
  })
  it('DESTROYED → gone (rootfs released, close period)', () => {
    expect(billingPeriodKind(BoxState.DESTROYED)).toBe('gone')
  })
})

describe('aggregatePeriods', () => {
  const from = new Date('2026-06-25T00:00:00Z')
  const to = new Date('2026-06-26T00:00:00Z')

  it('running period: cpu + ram + disk all count', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-25T12:00:00Z'),
        endAt: new Date('2026-06-25T12:00:10Z'), // 10s
        kind: 'running',
        allocCpu: 2,
        allocMemGib: 4,
        allocDiskGib: 10,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 20, // 2 vCPU × 10s
      totalRamGbSeconds: 40, // 4 GiB × 10s
      totalDiskGbSeconds: 100, // 10 GiB × 10s
    })
  })

  it('stopped period: only disk counts', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-25T12:00:00Z'),
        endAt: new Date('2026-06-25T12:00:10Z'), // 10s
        kind: 'stopped',
        allocCpu: 2,
        allocMemGib: 4,
        allocDiskGib: 10,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 0,
      totalRamGbSeconds: 0,
      totalDiskGbSeconds: 100,
    })
  })

  it('open period (endAt null) is clipped at `to`', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-25T23:59:50Z'), // 10s before `to`
        endAt: null,
        kind: 'running',
        allocCpu: 1,
        allocMemGib: 1,
        allocDiskGib: 1,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 10,
      totalRamGbSeconds: 10,
      totalDiskGbSeconds: 10,
    })
  })

  it('clips a period overlapping the range start', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-24T23:59:50Z'), // starts 10s before `from`
        endAt: new Date('2026-06-25T00:00:10Z'), // ends 10s after `from`
        kind: 'running',
        allocCpu: 1,
        allocMemGib: 1,
        allocDiskGib: 1,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 10, // only the 10s inside [from,to]
      totalRamGbSeconds: 10,
      totalDiskGbSeconds: 10,
    })
  })

  it('drops a period entirely outside the range', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-20T00:00:00Z'),
        endAt: new Date('2026-06-20T01:00:00Z'),
        kind: 'running',
        allocCpu: 9,
        allocMemGib: 9,
        allocDiskGib: 9,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 0,
      totalRamGbSeconds: 0,
      totalDiskGbSeconds: 0,
    })
  })

  it('sums mixed running + stopped periods (Disk continuous across both)', () => {
    const periods: BillablePeriod[] = [
      {
        startAt: new Date('2026-06-25T12:00:00Z'),
        endAt: new Date('2026-06-25T12:00:10Z'), // running 10s
        kind: 'running',
        allocCpu: 2,
        allocMemGib: 4,
        allocDiskGib: 10,
      },
      {
        startAt: new Date('2026-06-25T12:00:10Z'),
        endAt: new Date('2026-06-25T12:00:30Z'), // stopped 20s
        kind: 'stopped',
        allocCpu: 2,
        allocMemGib: 4,
        allocDiskGib: 10,
      },
    ]
    expect(aggregatePeriods(periods, from, to)).toEqual({
      totalCpuSeconds: 20, // running 10s × 2
      totalRamGbSeconds: 40, // running 10s × 4
      totalDiskGbSeconds: 300, // (10s + 20s) × 10
    })
  })
})

describe('planReconcileClose', () => {
  const periodStart = new Date('2026-06-26T12:00:00Z')
  const now = new Date('2026-06-26T12:30:00Z')

  it('leaves a running box with an open running period alone', () => {
    expect(
      planReconcileClose({
        openKind: 'running',
        periodStart,
        box: { state: BoxState.STARTED, updatedAt: periodStart },
        runnerAlive: true,
        lastAliveAt: now,
        now,
      }),
    ).toBeNull()
  })

  it('leaves a stopped box with an open stopped (disk-only) period alone', () => {
    expect(
      planReconcileClose({
        openKind: 'stopped',
        periodStart,
        box: { state: BoxState.STOPPED, updatedAt: periodStart },
        runnerAlive: true,
        lastAliveAt: now,
        now,
      }),
    ).toBeNull()
  })

  it('closes an open running period when the box is no longer running (missed stop)', () => {
    const stoppedAt = new Date('2026-06-26T12:10:00Z')
    expect(
      planReconcileClose({
        openKind: 'running',
        periodStart,
        box: { state: BoxState.STOPPED, updatedAt: stoppedAt },
        runnerAlive: true,
        lastAliveAt: now,
        now,
      }),
    ).toEqual({ closeAt: stoppedAt }) // close at the box's stop transition
  })

  it('closes any open period when the box is destroyed', () => {
    const destroyedAt = new Date('2026-06-26T12:15:00Z')
    expect(
      planReconcileClose({
        openKind: 'stopped',
        periodStart,
        box: { state: BoxState.DESTROYED, updatedAt: destroyedAt },
        runnerAlive: true,
        lastAliveAt: now,
        now,
      }),
    ).toEqual({ closeAt: destroyedAt })
  })

  it('closes at the last heartbeat when the runner is dead (box.state stale at STARTED)', () => {
    const lastAliveAt = new Date('2026-06-26T12:20:00Z')
    expect(
      planReconcileClose({
        openKind: 'running',
        periodStart,
        box: { state: BoxState.STARTED, updatedAt: periodStart }, // stale: still says running
        runnerAlive: false,
        lastAliveAt,
        now,
      }),
    ).toEqual({ closeAt: lastAliveAt }) // NOT periodStart, NOT now
  })

  it('closes at now when the box row is gone and no heartbeat known', () => {
    expect(
      planReconcileClose({
        openKind: 'running',
        periodStart,
        box: null,
        runnerAlive: true,
        lastAliveAt: null,
        now,
      }),
    ).toEqual({ closeAt: now })
  })

  it('clamps a stale close time up to periodStart (never ends before it starts)', () => {
    const beforeStart = new Date('2026-06-26T11:00:00Z') // earlier than periodStart
    const result = planReconcileClose({
      openKind: 'running',
      periodStart,
      box: { state: BoxState.STOPPED, updatedAt: beforeStart },
      runnerAlive: true,
      lastAliveAt: now,
      now,
    })
    expect(result).toEqual({ closeAt: periodStart }) // clamped, satisfies CHECK constraint
  })

  it('clamps a future close time down to now', () => {
    const future = new Date('2026-06-26T13:00:00Z')
    const result = planReconcileClose({
      openKind: 'running',
      periodStart,
      box: null,
      runnerAlive: false,
      lastAliveAt: future,
      now,
    })
    expect(result).toEqual({ closeAt: now }) // clamped down
  })
})
