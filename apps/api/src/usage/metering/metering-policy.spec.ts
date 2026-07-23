/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { MeteringMode, MeteringPolicy } from './metering-policy'

function box(state: BoxState, desiredState: BoxDesiredState, organizationId = 'org-1'): Box {
  return { state, desiredState, organizationId } as Box
}

describe('MeteringPolicy', () => {
  const policy = new MeteringPolicy()

  it.each([
    [BoxState.STARTED, BoxDesiredState.STARTED, MeteringMode.FULL],
    [BoxState.STARTED, BoxDesiredState.STOPPED, MeteringMode.DISK_ONLY],
    [BoxState.STOPPING, BoxDesiredState.STOPPED, MeteringMode.DISK_ONLY],
    [BoxState.STOPPED, BoxDesiredState.STARTED, MeteringMode.DISK_ONLY],
    [BoxState.STARTING, BoxDesiredState.STARTED, MeteringMode.PRESERVE],
    [BoxState.RESIZING, BoxDesiredState.STARTED, MeteringMode.PRESERVE],
    [BoxState.ERROR, BoxDesiredState.STARTED, MeteringMode.NONE],
    [BoxState.ERROR, BoxDesiredState.STOPPED, MeteringMode.NONE],
    [BoxState.STARTED, BoxDesiredState.DESTROYED, MeteringMode.NONE],
  ])('maps %s with desired %s to %s', (state, desiredState, expected) => {
    expect(policy.resolve(box(state, desiredState))).toBe(expected)
  })

  it('never meters an unassigned warm-pool box', () => {
    expect(policy.resolve(box(BoxState.STARTED, BoxDesiredState.STARTED, BOX_WARM_POOL_UNASSIGNED_ORGANIZATION))).toBe(
      MeteringMode.NONE,
    )
  })
})
