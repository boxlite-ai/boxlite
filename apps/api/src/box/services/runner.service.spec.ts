/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerState } from '../enums/runner-state.enum'
import { RunnerService } from './runner.service'

describe('RunnerService lease cancellation', () => {
  const makeService = () => {
    const service = Object.create(RunnerService.prototype) as RunnerService
    Object.assign(service as any, {
      logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() },
      eventEmitter: { emit: jest.fn() },
      dataSource: {},
      serviceStartTime: new Date(Date.now() - 120_000),
    })
    return service
  }

  it('does not update a stale v2 runner when ownership is lost during lookup', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    const runner = {
      id: 'runner-1',
      apiVersion: '2',
      state: RunnerState.READY,
      lastChecked: new Date(Date.now() - 120_000),
    }
    const service = makeService()
    Object.assign(service as any, {
      findOne: jest.fn(async () => {
        controller.abort(ownershipError)
        return runner
      }),
      updateRunner: jest.fn().mockResolvedValue(undefined),
    })

    await expect((service as any).checkRunnerV2Health(runner, controller.signal)).rejects.toBe(ownershipError)
    expect((service as any).updateRunner).not.toHaveBeenCalled()
  })

  it('propagates a v2 runner update failure after all runner work settles', async () => {
    const updateError = new Error('runner update failed')
    const release = jest.fn().mockResolvedValue(undefined)
    const runner = {
      id: 'runner-1',
      apiVersion: '2',
      state: RunnerState.READY,
      lastChecked: new Date(Date.now() - 120_000),
    }
    const service = makeService()
    Object.assign(service as any, {
      runnerRepository: { find: jest.fn().mockResolvedValue([runner]) },
      redisLockProvider: { acquireLease: jest.fn().mockResolvedValue({ release }) },
      findOne: jest.fn().mockResolvedValue(runner),
      updateRunner: jest.fn().mockRejectedValue(updateError),
    })

    await expect((service as any).handleCheckRunners()).rejects.toBe(updateError)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('propagates lease cancellation to an in-flight v0 health request', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    const release = jest.fn().mockResolvedValue(undefined)
    let healthSignal: AbortSignal | undefined
    const service = makeService()
    Object.assign(service as any, {
      runnerRepository: {
        find: jest.fn().mockResolvedValue([
          { id: 'runner-1', apiVersion: '0', state: RunnerState.UNRESPONSIVE },
        ]),
      },
      redisLockProvider: {
        acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release }),
      },
      runnerAdapterFactory: {
        create: jest.fn().mockResolvedValue({
          healthCheck: jest.fn(async (signal: AbortSignal) => {
            healthSignal = signal
            controller.abort(ownershipError)
            signal.throwIfAborted()
          }),
        }),
      },
      configService: { get: jest.fn().mockReturnValue(60) },
    })

    await expect((service as any).handleCheckRunners()).rejects.toBe(ownershipError)

    expect(healthSignal?.aborted).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not mutate draining state after ownership is lost during the box count', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    const release = jest.fn().mockResolvedValue(undefined)
    const service = makeService()
    const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() }
    Object.assign(service as any, {
      runnerRepository: {
        find: jest.fn().mockResolvedValue([{ id: 'runner-1', draining: true, state: RunnerState.READY }]),
      },
      boxRepository: {
        count: jest.fn(async () => {
          controller.abort(ownershipError)
          return 0
        }),
      },
      redisLockProvider: {
        acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release }),
      },
      redis,
      updateRunner: jest.fn(),
    })

    await expect((service as any).handleCheckDecommissionRunners()).rejects.toBe(ownershipError)

    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
    expect((service as any).updateRunner).not.toHaveBeenCalled()
  })
})
