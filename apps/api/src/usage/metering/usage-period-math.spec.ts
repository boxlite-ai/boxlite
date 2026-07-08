/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import {
  aggregateUsagePeriods,
  planUsageTransition,
  usagePeriodKind,
  UsagePeriodLike,
} from './usage-period-math'

describe('usagePeriodKind', () => {
  it('maps STARTED to running compute plus disk', () => {
    expect(usagePeriodKind(BoxState.STARTED, BoxDesiredState.STARTED)).toBe('running')
  })

  it('keeps hot resize as running when desired state is STARTED', () => {
    expect(usagePeriodKind(BoxState.RESIZING, BoxDesiredState.STARTED)).toBe('running')
  })

  it('treats stopped and stopped resize as disk-only', () => {
    expect(usagePeriodKind(BoxState.STOPPED, BoxDesiredState.STOPPED)).toBe('stopped')
    expect(usagePeriodKind(BoxState.RESIZING, BoxDesiredState.STOPPED)).toBe('stopped')
  })

  it('maps destroy states to gone', () => {
    expect(usagePeriodKind(BoxState.DESTROYING, BoxDesiredState.DESTROYED)).toBe('gone')
    expect(usagePeriodKind(BoxState.DESTROYED, BoxDesiredState.DESTROYED)).toBe('gone')
  })
})

describe('planUsageTransition', () => {
  it('opens a running period when there is no open period and the box starts', () => {
    expect(planUsageTransition(null, BoxState.STARTED, BoxDesiredState.STARTED)).toEqual({
      closeOpen: false,
      openKind: 'running',
    })
  })

  it('closes running and opens stopped when a box stops', () => {
    expect(planUsageTransition('running', BoxState.STOPPED, BoxDesiredState.STOPPED)).toEqual({
      closeOpen: true,
      openKind: 'stopped',
    })
  })

  it('does not fragment same-kind transitions', () => {
    expect(planUsageTransition('running', BoxState.RESIZING, BoxDesiredState.STARTED)).toEqual({
      closeOpen: false,
      openKind: null,
    })
  })

  it('closes the open period and opens nothing when a box is destroyed', () => {
    expect(planUsageTransition('stopped', BoxState.DESTROYED, BoxDesiredState.DESTROYED)).toEqual({
      closeOpen: true,
      openKind: null,
    })
  })
})

describe('aggregateUsagePeriods', () => {
  const from = new Date('2026-07-08T00:00:00Z')
  const to = new Date('2026-07-08T00:01:00Z')

  it('bills cpu, memory, disk, and gpu for running periods', () => {
    const periods: UsagePeriodLike[] = [
      {
        startAt: new Date('2026-07-08T00:00:10Z'),
        endAt: new Date('2026-07-08T00:00:20Z'),
        kind: 'running',
        cpu: 2,
        mem: 4,
        disk: 10,
        gpu: 1,
      },
    ]

    expect(aggregateUsagePeriods(periods, from, to)).toEqual({
      cpuSeconds: 20,
      memGibSeconds: 40,
      diskGibSeconds: 100,
      gpuSeconds: 10,
    })
  })

  it('bills only disk for stopped periods', () => {
    const periods: UsagePeriodLike[] = [
      {
        startAt: new Date('2026-07-08T00:00:10Z'),
        endAt: new Date('2026-07-08T00:00:20Z'),
        kind: 'stopped',
        cpu: 2,
        mem: 4,
        disk: 10,
        gpu: 1,
      },
    ]

    expect(aggregateUsagePeriods(periods, from, to)).toEqual({
      cpuSeconds: 0,
      memGibSeconds: 0,
      diskGibSeconds: 100,
      gpuSeconds: 0,
    })
  })

  it('clips open and overlapping periods to the requested range', () => {
    const periods: UsagePeriodLike[] = [
      {
        startAt: new Date('2026-07-07T23:59:50Z'),
        endAt: null,
        kind: 'running',
        cpu: 1,
        mem: 1,
        disk: 1,
        gpu: 0,
      },
    ]

    expect(aggregateUsagePeriods(periods, from, to)).toEqual({
      cpuSeconds: 60,
      memGibSeconds: 60,
      diskGibSeconds: 60,
      gpuSeconds: 0,
    })
  })
})
