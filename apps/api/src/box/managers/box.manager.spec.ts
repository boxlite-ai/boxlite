/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode } from '../common/redis-lock.provider'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxConflictError } from '../errors/box-conflict.error'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { BoxManager } from './box.manager'

describe('BoxManager state lock ownership', () => {
  it('releases a state lock only with the token that acquired it', async () => {
    const boxId = 'box000000001'
    const boxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue({
        id: boxId,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
      }),
    }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new BoxManager(
      boxRepository as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      {} as never,
      {} as never,
      {} as never,
    )

    await manager.syncInstanceState(boxId)

    const lockCode = redisLockProvider.lock.mock.calls[0][2]
    expect(lockCode).toBeInstanceOf(LockCode)
    expect(redisLockProvider.lock).toHaveBeenCalledWith(getStateChangeLockKey(boxId), 30, lockCode)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith(getStateChangeLockKey(boxId), lockCode)
  })

  it('does not write ERROR when the action fails after another sync owner acquired the lock', async () => {
    const boxId = 'box000000001'
    const boxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue({
        id: boxId,
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STARTED,
        pending: true,
      }),
      updateWhere: jest.fn(),
    }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      getCode: jest.fn().mockResolvedValue(new LockCode('new-owner')),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new BoxManager(
      boxRepository as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      { run: jest.fn().mockRejectedValue(new Error('old request failed')) } as never,
      {} as never,
      {} as never,
    )

    await manager.syncInstanceState(boxId)

    expect(redisLockProvider.getCode).toHaveBeenCalledWith(getStateChangeLockKey(boxId))
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('guards an owned ERROR transition with the Box concurrency snapshot', async () => {
    const boxId = 'box000000001'
    const box = {
      id: boxId,
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    }
    const boxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(box),
      updateWhere: jest.fn().mockResolvedValue(box),
    }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      getCode: jest.fn().mockImplementation(async () => redisLockProvider.lock.mock.calls[0][2]),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new BoxManager(
      boxRepository as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      { run: jest.fn().mockRejectedValue(new Error('owned request failed')) } as never,
      {} as never,
      {} as never,
    )

    await manager.syncInstanceState(boxId)

    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      boxId,
      expect.objectContaining({
        whereCondition: {
          state: BoxState.STOPPED,
          desiredState: BoxDesiredState.STARTED,
          pending: true,
        },
      }),
    )
  })

  it('treats a concurrent Box change during ERROR handling as a stale owner', async () => {
    const boxId = 'box000000001'
    const boxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue({
        id: boxId,
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STARTED,
        pending: true,
      }),
      updateWhere: jest.fn().mockRejectedValue(new BoxConflictError()),
    }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      getCode: jest.fn().mockImplementation(async () => redisLockProvider.lock.mock.calls[0][2]),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new BoxManager(
      boxRepository as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      { run: jest.fn().mockRejectedValue(new Error('owned request failed')) } as never,
      {} as never,
      {} as never,
    )

    await expect(manager.syncInstanceState(boxId)).resolves.toBeUndefined()
  })
})
