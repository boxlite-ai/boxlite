/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerState } from '../enums/runner-state.enum'
import { RunnerService } from './runner.service'

describe('RunnerService decommission verification', () => {
  const createService = (boxCount: number, checkCount: string | null = null) => {
    const runner = { id: 'runner-1', draining: true, state: RunnerState.READY }
    const runnerRepository = {
      find: jest.fn().mockResolvedValue([runner]),
      findOne: jest.fn().mockResolvedValue(runner),
      findOneOrFail: jest.fn().mockResolvedValue(runner),
      save: jest.fn().mockResolvedValue(runner),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const boxRepository = { count: jest.fn().mockResolvedValue(boxCount) }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      acquireLease: jest.fn().mockResolvedValue({
        signal: new AbortController().signal,
        release: jest.fn().mockResolvedValue(undefined),
      }),
      waitForLease: jest.fn().mockResolvedValue({
        signal: new AbortController().signal,
        release: jest.fn().mockResolvedValue(undefined),
      }),
    }
    const configService = { getOrThrow: jest.fn().mockReturnValue(1) }
    const redis = {
      get: jest.fn().mockResolvedValue(checkCount),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    }
    const dataSource = { queryResultCache: undefined }
    const service = new RunnerService(
      runnerRepository as any,
      {} as any,
      boxRepository as any,
      redisLockProvider as any,
      configService as any,
      {} as any,
      { emit: jest.fn() } as any,
      dataSource as any,
      redis as any,
    )

    return { service, runnerRepository, boxRepository, redisLockProvider, redis }
  }

  it('resets verification while any box is still assigned to the draining runner', async () => {
    const { service, runnerRepository, boxRepository, redis } = createService(1, '2')

    await (service as any).handleCheckDecommissionRunners()

    expect(boxRepository.count).toHaveBeenCalledWith({ where: { runnerId: 'runner-1' } })
    expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
    expect(runnerRepository.update).not.toHaveBeenCalled()
  })

  it('decommissions only after three checks with no remaining runner assignments', async () => {
    const { service, runnerRepository, redis } = createService(0, '2')

    await (service as any).handleCheckDecommissionRunners()

    expect(runnerRepository.update).toHaveBeenCalledWith('runner-1', { state: RunnerState.DECOMMISSIONED })
    expect(redis.del).toHaveBeenCalledWith('runner:draining-check:runner-1')
  })

  it('does not inspect runners when another worker owns the verification lock', async () => {
    const { service, runnerRepository, redisLockProvider } = createService(0)
    redisLockProvider.lock.mockResolvedValue(false)

    await (service as any).handleCheckDecommissionRunners()

    expect(runnerRepository.find).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })

  it('clears prior verification progress whenever draining status changes', async () => {
    const { service, redis } = createService(0, '2')

    await service.updateDrainingStatus('runner-1', false)

    expect(redis.del).toHaveBeenCalledWith('runner:draining-check:runner-1')
  })

  it('does not publish decommission when an assignment appears after taking the assignment fence', async () => {
    const { service, runnerRepository, boxRepository, redis, redisLockProvider } = createService(0, '2')
    boxRepository.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1)

    await (service as any).handleCheckDecommissionRunners()

    expect(runnerRepository.update).not.toHaveBeenCalled()
    expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
    expect(redisLockProvider.acquireLease).toHaveBeenCalledWith('runner:runner-1:box-assignment', 30)
  })

  it('does not decommission when draining is cleared before final verification', async () => {
    const { service, runnerRepository, boxRepository } = createService(0, '2')
    runnerRepository.findOne.mockResolvedValue({ id: 'runner-1', draining: false, state: RunnerState.READY })

    await (service as any).handleCheckDecommissionRunners()

    expect(boxRepository.count).toHaveBeenCalledTimes(1)
    expect(runnerRepository.update).not.toHaveBeenCalled()
  })

  it('updates draining while holding the runner assignment lease', async () => {
    const { service, redisLockProvider } = createService(0)

    await service.updateDrainingStatus('runner-1', false)

    expect(redisLockProvider.waitForLease).toHaveBeenCalledWith(
      'runner:runner-1:box-assignment',
      30,
      expect.any(AbortSignal),
    )
  })

  it('keeps a runner decommissioned when an in-flight health write completes later', async () => {
    const { service, runnerRepository } = createService(0)
    runnerRepository.findOne.mockResolvedValue({ id: 'runner-1', state: RunnerState.READY })

    await service.updateRunnerHealth('runner-1')

    expect(runnerRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'runner-1',
        state: expect.any(Object),
      }),
      expect.objectContaining({ state: RunnerState.READY }),
    )
  })

  it('translates a missing uncached runner into NotFoundException', async () => {
    const { service, runnerRepository } = createService(0)
    runnerRepository.findOne.mockResolvedValue(null)

    await expect(service.findOneUncachedOrFail('missing')).rejects.toMatchObject({ status: 404 })
  })
})
