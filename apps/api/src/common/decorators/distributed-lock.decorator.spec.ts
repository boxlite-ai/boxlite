/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DistributedLock } from './distributed-lock.decorator'

describe('DistributedLock', () => {
  it('passes the lease abort signal to the protected method', async () => {
    const controller = new AbortController()
    class Worker {
      redisLockProvider = {
        acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release: jest.fn() }),
      }

      @DistributedLock()
      async run(signal?: AbortSignal) {
        return signal
      }
    }

    await expect(new Worker().run()).resolves.toBe(controller.signal)
  })
})
