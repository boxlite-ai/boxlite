/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxService } from './box.service'

function makeBox(state: BoxState, desiredState = BoxDesiredState.STARTED): Box {
  const box = new Box('us', 'loader')
  box.id = 'box-1'
  box.state = state
  box.desiredState = desiredState
  box.runnerId = 'runner-1'
  box.pending = false
  return box
}

function createService(box: Box): { service: BoxService; updateWhere: jest.Mock } {
  const service = Object.create(BoxService.prototype) as BoxService
  const updateWhere = jest.fn().mockResolvedValue(box)

  ;(service as any).logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }
  ;(service as any).boxRepository = { findOne: jest.fn().mockResolvedValue(box), updateWhere }

  return { service, updateWhere }
}

function writtenUpdate(updateWhere: jest.Mock): Partial<Box> {
  expect(updateWhere).toHaveBeenCalledTimes(1)
  return updateWhere.mock.calls[0][1].updateData
}

// The runner reports the main command's exit code with the stop that command
// caused. That report is the only chance to record it — the VM is gone
// afterwards, and nothing can be asked for it again.
describe('BoxService.updateState main command exit code', () => {
  it.each([
    ['a failing main command', 137],
    // 0 has to survive the write path: it is the only thing separating a box
    // that finished its work from one that crashed.
    ['a main command that succeeded', 0],
  ])('records the exit code reported with a stop for %s', async (_case, exitCode) => {
    const box = makeBox(BoxState.STARTED)
    const { service, updateWhere } = createService(box)

    await service.updateState(box.id, BoxState.STOPPED, false, undefined, exitCode)

    expect(writtenUpdate(updateWhere).exitCode).toBe(exitCode)
  })

  it('leaves the stored exit code alone when a stop reports none', async () => {
    const box = makeBox(BoxState.STARTED)
    const { service, updateWhere } = createService(box)

    await service.updateState(box.id, BoxState.STOPPED)

    expect(writtenUpdate(updateWhere)).not.toHaveProperty('exitCode')
  })

  // Without this, a box resumed after a crash keeps reporting the crash code
  // while it is serving traffic — worse than having no field at all.
  it('clears the previous run exit code when the box starts again', async () => {
    const box = makeBox(BoxState.STOPPED)
    box.exitCode = 137
    const { service, updateWhere } = createService(box)

    await service.updateState(box.id, BoxState.STARTED)

    expect(writtenUpdate(updateWhere).exitCode).toBeNull()
  })
})
