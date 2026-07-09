/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxManager } from './box.manager'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'

function buildHarness(box: { state: BoxState; desiredState: BoxDesiredState }) {
  const updateWhere = jest.fn().mockResolvedValue(undefined)
  const boxRepository: any = {
    findOneOrFail: jest.fn().mockResolvedValue({ id: 'box-1', runnerId: 'runner-1', ...box }),
    updateWhere,
  }
  const runnerService: any = {
    getRunnerApiVersion: jest.fn().mockResolvedValue('2'),
  }
  const redisLockProvider: any = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const thrower = jest.fn().mockRejectedValue(new Error('runner unreachable'))
  const manager = new BoxManager(
    boxRepository,
    runnerService,
    redisLockProvider,
    { run: box.desiredState === BoxDesiredState.STARTED ? thrower : jest.fn() } as any,
    { run: box.desiredState === BoxDesiredState.STOPPED ? thrower : jest.fn() } as any,
    { run: jest.fn() } as any,
  )
  return { manager, updateWhere }
}

describe('BoxManager.syncInstanceState error handling', () => {
  afterEach(() => jest.clearAllMocks())

  it('withdraws STARTED intent when start sync fails before a job completes', async () => {
    const { manager, updateWhere } = buildHarness({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
    })

    await manager.syncInstanceState('box-1')

    expect(updateWhere).toHaveBeenCalledTimes(1)
    expect(updateWhere.mock.calls[0][1].updateData).toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STOPPED,
    })
  })

  it('does not overwrite STOPPED intent when stop sync fails', async () => {
    const { manager, updateWhere } = buildHarness({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STOPPED,
    })

    await manager.syncInstanceState('box-1')

    expect(updateWhere).toHaveBeenCalledTimes(1)
    expect(updateWhere.mock.calls[0][1].updateData).toMatchObject({
      state: BoxState.ERROR,
    })
    expect(updateWhere.mock.calls[0][1].updateData.desiredState).toBeUndefined()
  })
})
