/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxStartAction } from './box-start.action'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { BoxDesiredState } from '../../enums/box-desired-state.enum'
import { LockCode } from '../../common/redis-lock.provider'

// One of the three writers of box state. A code recorded for the run that
// ended must not survive into the next one, and this writer owns the
// lifecycle transitions — leaving it out would let a box that is up answer
// with the exit code of its previous life.
describe('BoxAction.updateBoxState main command exit code', () => {
  function makeAction() {
    const lockCode = new LockCode('lock-1')
    const update = jest.fn().mockResolvedValue(undefined)
    const action = new BoxStartAction(
      {} as any,
      {} as any,
      { update } as any,
      {} as any,
      {} as any,
      { getCode: jest.fn(async () => lockCode) } as any,
      {} as any,
    )
    return { action, lockCode, update }
  }

  function makeBox(state: BoxState): Box {
    const box = new Box('us', 'loader')
    box.id = 'box-1'
    box.state = state
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true
    box.exitCode = 137
    return box
  }

  function writtenUpdate(update: jest.Mock): Partial<Box> {
    expect(update).toHaveBeenCalledTimes(1)
    return update.mock.calls[0][1].updateData
  }

  it.each([BoxState.CREATING, BoxState.RESTORING, BoxState.STARTING, BoxState.STARTED])(
    'clears the previous run exit code when moving to %s',
    async (state) => {
      const { action, lockCode, update } = makeAction()

      await (action as any).updateBoxState(makeBox(BoxState.STOPPED), state, lockCode)

      expect(writtenUpdate(update).exitCode).toBeNull()
    },
  )

  // The stop is what records a code, so the transition that reports it must
  // not turn around and wipe it.
  it('leaves the exit code alone when the box is stopping', async () => {
    const { action, lockCode, update } = makeAction()

    await (action as any).updateBoxState(makeBox(BoxState.STARTED), BoxState.STOPPING, lockCode)

    expect(writtenUpdate(update)).not.toHaveProperty('exitCode')
  })
})
