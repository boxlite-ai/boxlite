/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDestroyAction } from './box-destroy.action'
import { BoxAction } from './box.action'
import { Box } from '../../entities/box.entity'
import { Runner } from '../../entities/runner.entity'
import { BoxState } from '../../enums/box-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { LockCode } from '../../common/redis-lock.provider'

function setUp(box: Box, boxInfo: () => Promise<{ state: BoxState }>) {
  const runner = { id: box.runnerId, state: RunnerState.READY } as Runner
  const runnerService = { findOneOrFail: jest.fn(async () => runner) }
  const destroyBox = jest.fn(async () => undefined)
  const runnerAdapterFactory = { create: jest.fn(async () => ({ boxInfo, destroyBox }) as any) }
  const lockCode = new LockCode('lock-destroy')
  const boxRepository = { update: jest.fn(async () => box) }
  const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
  const cleanupForDestroyedBox = jest.fn(async () => undefined)
  const boxSshReconciliationService = { cleanupForDestroyedBox }

  const action = new BoxDestroyAction(
    runnerService as any,
    runnerAdapterFactory as any,
    boxRepository as any,
    redisLockProvider as any,
    boxSshReconciliationService as any,
  )

  return { action, lockCode, cleanupForDestroyedBox, destroyBox }
}

describe('BoxDestroyAction', () => {
  it('cleans up SSH resources when the runner reports the box already DESTROYED', async () => {
    const box = new Box('region-1', 'destroy-direct')
    box.runnerId = 'runner-1'
    box.state = BoxState.DESTROYING
    box.pending = true

    const { action, lockCode, cleanupForDestroyedBox } = setUp(box, async () => ({ state: BoxState.DESTROYED }))

    const result = await (action as BoxAction).run(box, lockCode)

    expect(cleanupForDestroyedBox).toHaveBeenCalledWith(box.id)
    expect(result).toBe('dont-sync-again')
  })

  it('cleans up SSH resources when an ARCHIVED box transitions straight to DESTROYED', async () => {
    const box = new Box('region-1', 'destroy-archived')
    box.runnerId = 'runner-1'
    box.state = BoxState.ARCHIVED
    box.pending = true

    const { action, lockCode, cleanupForDestroyedBox } = setUp(box, async () => ({ state: BoxState.DESTROYED }))

    await (action as BoxAction).run(box, lockCode)

    expect(cleanupForDestroyedBox).toHaveBeenCalledWith(box.id)
  })

  it('cleans up SSH resources when the runner reports the box not found (already gone)', async () => {
    const box = new Box('region-1', 'destroy-404')
    box.runnerId = 'runner-1'
    box.state = BoxState.DESTROYING
    box.pending = true

    const notFound = () => Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }))
    const { action, lockCode, cleanupForDestroyedBox } = setUp(box, notFound as any)

    await (action as BoxAction).run(box, lockCode)

    expect(cleanupForDestroyedBox).toHaveBeenCalledWith(box.id)
  })

  it('does not clean up SSH resources while the box is only DESTROYING (not yet DESTROYED)', async () => {
    const box = new Box('region-1', 'destroy-inflight')
    box.runnerId = 'runner-1'
    box.state = BoxState.STARTED
    box.pending = true

    const { action, lockCode, cleanupForDestroyedBox, destroyBox } = setUp(box, async () => ({
      state: BoxState.STARTED,
    }))

    const result = await (action as BoxAction).run(box, lockCode)

    expect(destroyBox).toHaveBeenCalledWith(box.id)
    expect(cleanupForDestroyedBox).not.toHaveBeenCalled()
    expect(result).toBe('sync-again')
  })

  it('does not fail the destroy transition when SSH cleanup itself errors', async () => {
    const box = new Box('region-1', 'destroy-cleanup-fails')
    box.runnerId = 'runner-1'
    box.state = BoxState.DESTROYING
    box.pending = true

    const { action, lockCode, cleanupForDestroyedBox } = setUp(box, async () => ({ state: BoxState.DESTROYED }))
    cleanupForDestroyedBox.mockRejectedValueOnce(new Error('db unavailable'))

    await expect((action as BoxAction).run(box, lockCode)).resolves.toBe('dont-sync-again')
  })
})
