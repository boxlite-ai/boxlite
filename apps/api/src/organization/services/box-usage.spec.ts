/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import {
  BOX_STATES_CONSUMING_COMPUTE,
  BOX_STATES_CONSUMING_DISK,
} from '../constants/box-consuming-states.constant'
import { boxUsageContribution, resizeQuotaDeltas, stateTransitionDelta } from './box-usage'

const box = (state: BoxState, desiredState: BoxDesiredState = BoxDesiredState.STOPPED) => ({
  state,
  desiredState,
  cpu: 2,
  mem: 4,
  disk: 10,
  gpu: 1,
})

describe('boxUsageContribution', () => {
  it('a running box charges full compute + disk + one slot', () => {
    expect(boxUsageContribution(box(BoxState.STARTED))).toEqual({ cpu: 2, memory: 4, gpu: 1, count: 1, disk: 10 })
  })

  it('a stopped box charges only disk (no compute, no slot)', () => {
    expect(boxUsageContribution(box(BoxState.STOPPED))).toEqual({ cpu: 0, memory: 0, gpu: 0, count: 0, disk: 10 })
  })

  it('an archiving box charges only disk', () => {
    expect(boxUsageContribution(box(BoxState.ARCHIVING))).toEqual({ cpu: 0, memory: 0, gpu: 0, count: 0, disk: 10 })
  })

  it('a terminal box charges nothing', () => {
    expect(boxUsageContribution(box(BoxState.DESTROYED))).toEqual({ cpu: 0, memory: 0, gpu: 0, count: 0, disk: 0 })
  })

  it('a box on its way up (CREATING) already charges full compute', () => {
    expect(boxUsageContribution(box(BoxState.CREATING))).toEqual({ cpu: 2, memory: 4, gpu: 1, count: 1, disk: 10 })
  })

  it('a hot RESIZING box (desiredState STARTED) charges full compute + disk', () => {
    expect(boxUsageContribution(box(BoxState.RESIZING, BoxDesiredState.STARTED))).toEqual({
      cpu: 2,
      memory: 4,
      gpu: 1,
      count: 1,
      disk: 10,
    })
  })

  it('a cold RESIZING box (desiredState STOPPED) charges only disk', () => {
    expect(boxUsageContribution(box(BoxState.RESIZING, BoxDesiredState.STOPPED))).toEqual({
      cpu: 0,
      memory: 0,
      gpu: 0,
      count: 0,
      disk: 10,
    })
  })
})

describe('stateTransitionDelta', () => {
  it('charges +amount when entering the consuming set', () => {
    expect(stateTransitionDelta(2, BoxState.STOPPED, BoxState.STARTED, BOX_STATES_CONSUMING_COMPUTE)).toBe(2)
  })

  it('refunds -amount when leaving the consuming set', () => {
    expect(stateTransitionDelta(2, BoxState.STARTED, BoxState.STOPPED, BOX_STATES_CONSUMING_COMPUTE)).toBe(-2)
    // leaving to an errored state also frees compute
    expect(stateTransitionDelta(2, BoxState.STARTED, BoxState.ERROR, BOX_STATES_CONSUMING_COMPUTE)).toBe(-2)
  })

  it('is 0 when membership does not change', () => {
    // both consuming compute
    expect(stateTransitionDelta(2, BoxState.CREATING, BoxState.STARTED, BOX_STATES_CONSUMING_COMPUTE)).toBe(0)
    // STARTED -> STOPPED both still consume disk, so disk delta is 0
    expect(stateTransitionDelta(10, BoxState.STARTED, BoxState.STOPPED, BOX_STATES_CONSUMING_DISK)).toBe(0)
  })

  it('frees disk only when leaving the disk-consuming set entirely', () => {
    expect(stateTransitionDelta(10, BoxState.STOPPED, BoxState.DESTROYED, BOX_STATES_CONSUMING_DISK)).toBe(-10)
  })
})

describe('resizeQuotaDeltas', () => {
  it('hot growth charges the positive cpu/mem/disk deltas', () => {
    expect(resizeQuotaDeltas({ cpu: 2, mem: 4, disk: 10 }, { cpu: 4, mem: 8, disk: 20 }, true)).toEqual({
      cpu: 2,
      memory: 4,
      disk: 10,
    })
  })

  it('a cold (stopped) resize charges no cpu/memory, only disk', () => {
    expect(resizeQuotaDeltas({ cpu: 2, mem: 4, disk: 10 }, { cpu: 4, mem: 8, disk: 20 }, false)).toEqual({
      cpu: 0,
      memory: 0,
      disk: 10,
    })
  })

  it('shrinking charges nothing (deltas floored at 0)', () => {
    expect(resizeQuotaDeltas({ cpu: 4, mem: 8, disk: 20 }, { cpu: 2, mem: 4, disk: 20 }, true)).toEqual({
      cpu: 0,
      memory: 0,
      disk: 0,
    })
  })

  it('no change charges nothing', () => {
    expect(resizeQuotaDeltas({ cpu: 2, mem: 4, disk: 10 }, { cpu: 2, mem: 4, disk: 10 }, true)).toEqual({
      cpu: 0,
      memory: 0,
      disk: 0,
    })
  })
})
