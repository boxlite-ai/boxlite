/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { BoxState } from '../enums/box-state.enum'
import { beginsNewRun } from './exit-code.util'

// Typed as a total record over BoxState, so adding a state to the enum without
// deciding what it means for a recorded exit code fails to compile here. The
// runtime check below covers the same ground for a non-TypeScript caller.
const EXPECTED_BY_STATE: Record<BoxState, boolean> = {
  // Every state that puts a box back on its feet clears the previous run's
  // exit code; a box reported as up while carrying one reads as a box that
  // has already died.
  [BoxState.CREATING]: true,
  [BoxState.RESTORING]: true,
  [BoxState.STARTING]: true,
  [BoxState.STARTED]: true,
  // STOPPED is the state the exit code is recorded with, so it must survive it.
  [BoxState.STOPPED]: false,
  [BoxState.STOPPING]: false,
  [BoxState.ERROR]: false,
  [BoxState.DESTROYED]: false,
  [BoxState.DESTROYING]: false,
  [BoxState.ARCHIVED]: false,
  [BoxState.ARCHIVING]: false,
  [BoxState.RESIZING]: false,
  [BoxState.UNKNOWN]: false,
}

describe('beginsNewRun', () => {
  it('classifies every box state', () => {
    expect(Object.keys(EXPECTED_BY_STATE).sort()).toEqual(Object.values(BoxState).sort())
  })

  it.each(Object.entries(EXPECTED_BY_STATE))('classifies %s as %s', (state, expected) => {
    expect(beginsNewRun(state as BoxState)).toBe(expected)
  })
})
