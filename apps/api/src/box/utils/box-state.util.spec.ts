/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { reportedBoxState } from './box-state.util'

describe('reportedBoxState', () => {
  /**
   * A transition reads as the transition, not as the state being left: a
   * caller polling a box it just asked to stop is told it is stopping, rather
   * than that it is still started.
   */
  it.each([
    [BoxState.STARTED, BoxDesiredState.STOPPED, BoxState.STOPPING],
    [BoxState.STARTED, BoxDesiredState.DESTROYED, BoxState.DESTROYING],
    [BoxState.STOPPED, BoxDesiredState.STARTED, BoxState.STARTING],
    [BoxState.STOPPED, BoxDesiredState.DESTROYED, BoxState.DESTROYING],
  ])('reports %s heading for %s as %s', (state, desiredState, expected) => {
    expect(reportedBoxState({ state, desiredState })).toBe(expected)
  })

  /**
   * The runner has not reported on this box yet. Image preparation gates on
   * this answer too, so a box stored as UNKNOWN has to read as CREATING here or
   * its progress would never be reported.
   */
  it('reports a box the runner has not reported on, and that is meant to start, as creating', () => {
    expect(reportedBoxState({ state: BoxState.UNKNOWN, desiredState: BoxDesiredState.STARTED })).toBe(BoxState.CREATING)
  })

  it.each([
    [BoxState.STARTED, BoxDesiredState.STARTED],
    [BoxState.STARTED, BoxDesiredState.RESIZED],
    [BoxState.STOPPED, BoxDesiredState.STOPPED],
    [BoxState.UNKNOWN, BoxDesiredState.DESTROYED],
    [BoxState.CREATING, BoxDesiredState.STARTED],
    [BoxState.ERROR, BoxDesiredState.STARTED],
  ])('reports %s heading for %s as stored', (state, desiredState) => {
    expect(reportedBoxState({ state, desiredState })).toBe(state)
  })
})
