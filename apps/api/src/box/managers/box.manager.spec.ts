/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxManager } from './box.manager'
import { Readable } from 'stream'

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

  it('destroys the state stream without scheduling work after ownership is lost', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    const stream = Readable.from([{ box_id: 'box-1' }])
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      stream: jest.fn().mockResolvedValue(stream),
    }
    const boxRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }
    const release = jest.fn().mockResolvedValue(undefined)
    const redisLockProvider = {
      acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release }),
      isLocked: jest.fn(async () => {
        controller.abort(ownershipError)
        return false
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
    const syncInstanceState = jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await expect(manager.syncStates()).rejects.toBe(ownershipError)

    expect(syncInstanceState).not.toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
