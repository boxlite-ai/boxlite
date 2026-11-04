/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { DONT_SYNC_AGAIN } from './box-actions/box.action'
import { BoxManager } from './box.manager'

function managerFor(state: BoxState, desiredState: BoxDesiredState) {
  const boxRepository = {
    findOneOrFail: jest.fn().mockResolvedValue({
      id: 'box-1',
      state,
      desiredState,
      pending: desiredState !== BoxDesiredState.STOPPED,
      runnerId: null,
    }),
  }
  const stopAction = { run: jest.fn().mockResolvedValue(DONT_SYNC_AGAIN) }
  const destroyAction = { run: jest.fn().mockResolvedValue(DONT_SYNC_AGAIN) }
  const manager = new BoxManager(
    boxRepository as never,
    {} as never,
    {} as never,
    { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) } as never,
    { run: jest.fn() } as never,
    stopAction as never,
    destroyAction as never,
    {} as never,
  )
  return { manager, stopAction, destroyAction }
}

// A stopped box mid-snapshot differs from its desired state on purpose: the
// snapshot job's settlement ends the operation, so the sync loop must not try
// to stop it. Deleting it is a desired-state change the loop still drives.
describe('BoxManager.syncInstanceState and a box held by a snapshot job', () => {
  it.each([BoxState.EXPORTING, BoxState.IMPORTING])('leaves a stopped %s box to its job', async (state) => {
    const { manager, stopAction } = managerFor(state, BoxDesiredState.STOPPED)

    await manager.syncInstanceState('box-1')

    expect(stopAction.run).not.toHaveBeenCalled()
  })

  it('still drives the deletion of a box mid-snapshot', async () => {
    const { manager, destroyAction } = managerFor(BoxState.EXPORTING, BoxDesiredState.DESTROYED)

    await manager.syncInstanceState('box-1')

    expect(destroyAction.run).toHaveBeenCalledTimes(1)
  })
})
