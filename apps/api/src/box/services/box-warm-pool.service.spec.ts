/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxWarmPoolService } from './box-warm-pool.service'

describe('BoxWarmPoolService lease lifecycle', () => {
  it('waits for already-started top-ups before releasing a lost lease', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    let finishTopUp!: () => void
    const topUp = new Promise<void>((resolve) => {
      finishTopUp = resolve
    })
    const release = jest.fn().mockResolvedValue(undefined)
    const eventEmitter = {
      emitAsync: jest.fn(() => {
        controller.abort(ownershipError)
        return topUp
      }),
    }
    const service = new BoxWarmPoolService(
      { find: jest.fn().mockResolvedValue([{ id: 'pool-1', pool: 2 }]) } as any,
      { count: jest.fn().mockResolvedValue(0) } as any,
      {} as any,
      { acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release }) } as any,
      {} as any,
      eventEmitter as any,
      {} as any,
    )

    const checking = service.warmPoolCheck()
    while (eventEmitter.emitAsync.mock.calls.length === 0) {
      await Promise.resolve()
    }
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()

    finishTopUp()
    await expect(checking).rejects.toBe(ownershipError)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
