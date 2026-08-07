/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxManager } from './box.manager'

describe('BoxManager.syncInstanceState', () => {
  it('releases the state-change lease it acquired', async () => {
    const boxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue({
        id: 'box-1',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
      }),
    }
    const release = jest.fn().mockResolvedValue(undefined)
    const redisLockProvider = {
      acquireLease: jest.fn().mockResolvedValue({
        ownerCode: { getCode: () => 'owner-1' },
        release,
      }),
    }
    const manager = new BoxManager(
      boxRepository as any,
      {} as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      {} as any,
    )

    await manager.syncInstanceState('box-1')

    expect(redisLockProvider.acquireLease).toHaveBeenCalledWith('box:box-1:state-change', 30)
    expect(release).toHaveBeenCalled()
  })
})
