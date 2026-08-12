/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { Box } from '../entities/box.entity'
import { DONT_SYNC_AGAIN } from './box-actions/box.action'
import { BoxManager } from './box.manager'

describe('BoxManager runner draining', () => {
  const createBox = (id: string, state: BoxState): Box => {
    const box = new Box('us', id)
    box.id = id
    box.runnerId = 'runner-1'
    box.state = state
    box.desiredState = state as unknown as BoxDesiredState
    box.pending = false
    return box
  }

  const createManager = (force = false, cursor = '0') => {
    const boxRepository = {
      find: jest.fn(),
      findOneOrFail: jest.fn(),
      updateWhere: jest.fn().mockResolvedValue(undefined),
    }
    const runnerService = {
      findDrainingPaginated: jest.fn().mockResolvedValue([{ id: 'runner-1' }]),
      getRunnerApiVersion: jest.fn().mockResolvedValue('2'),
    }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const redis = {
      get: jest.fn().mockResolvedValue(cursor),
      set: jest.fn().mockResolvedValue('OK'),
    }
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'draining.force') return force
        return key === 'draining.runnerConcurrency' ? 2 : 10
      }),
    }
    const destroyAction = { run: jest.fn().mockResolvedValue(DONT_SYNC_AGAIN) }
    const manager = new BoxManager(
      boxRepository as any,
      runnerService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      destroyAction as any,
      redis as any,
      configService as any,
    )

    return { manager, boxRepository, runnerService, redisLockProvider, redis, destroyAction }
  }

  it('destroys stopped and errored boxes but leaves started boxes untouched by default', async () => {
    const { manager, boxRepository } = createManager()
    const stopped = createBox('stopped', BoxState.STOPPED)
    const errored = createBox('errored', BoxState.ERROR)
    boxRepository.find.mockResolvedValueOnce([stopped, errored]).mockResolvedValueOnce([])
    jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await manager.drainingRunnerBoxesCheck()

    expect(boxRepository.find).toHaveBeenCalledTimes(2)
    expect(boxRepository.updateWhere).toHaveBeenCalledTimes(2)
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      'stopped',
      expect.objectContaining({ updateData: expect.objectContaining({ desiredState: BoxDesiredState.DESTROYED }) }),
    )
  })

  it('requests a stop for started boxes when force draining is enabled', async () => {
    const { manager, boxRepository } = createManager(true)
    const started = createBox('started', BoxState.STARTED)
    boxRepository.find.mockResolvedValueOnce([started]).mockResolvedValueOnce([])
    jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await manager.drainingRunnerBoxesCheck()

    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      'started',
      expect.objectContaining({
        updateData: expect.objectContaining({ desiredState: BoxDesiredState.STOPPED, pending: true }),
      }),
    )
    expect(manager.syncInstanceState).toHaveBeenCalledWith('started', true)
  })

  it('uses the safe destroy path for recoverable errors until stopped recovery is supported', async () => {
    const { manager, boxRepository } = createManager()
    const errored = createBox('recoverable', BoxState.ERROR)
    errored.recoverable = true
    boxRepository.find.mockResolvedValueOnce([errored]).mockResolvedValueOnce([])
    jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await manager.drainingRunnerBoxesCheck()

    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      errored.id,
      expect.objectContaining({
        updateData: expect.objectContaining({ desiredState: BoxDesiredState.DESTROYED }),
      }),
    )
  })

  it('does no work when another worker owns the draining lock', async () => {
    const { manager, boxRepository, runnerService, redisLockProvider } = createManager()
    redisLockProvider.lock.mockResolvedValueOnce(false)

    await manager.drainingRunnerBoxesCheck()

    expect(runnerService.findDrainingPaginated).not.toHaveBeenCalled()
    expect(boxRepository.find).not.toHaveBeenCalled()
  })

  it('rotates the draining runner cursor so stuck first-page runners cannot starve later runners', async () => {
    const { manager, boxRepository, runnerService, redis } = createManager(false, '10')
    boxRepository.find.mockResolvedValue([])

    await manager.drainingRunnerBoxesCheck()

    expect(runnerService.findDrainingPaginated).toHaveBeenCalledWith(10, 10)
    expect(redis.set).toHaveBeenCalledWith('draining-runner-boxes-skip', 11)
  })

  it('resets the draining runner cursor after reaching an empty page', async () => {
    const { manager, runnerService, redis } = createManager(false, '20')
    runnerService.findDrainingPaginated.mockResolvedValue([])

    await manager.drainingRunnerBoxesCheck()

    expect(runnerService.findDrainingPaginated).toHaveBeenCalledWith(20, 10)
    expect(redis.set).toHaveBeenCalledWith('draining-runner-boxes-skip', 0)
  })

  it('reconciles an errored box whose desired state is destroyed', async () => {
    const { manager, boxRepository, destroyAction } = createManager()
    const box = createBox('errored', BoxState.ERROR)
    box.desiredState = BoxDesiredState.DESTROYED
    box.pending = true
    boxRepository.findOneOrFail.mockResolvedValue(box)

    await manager.syncInstanceState(box.id)

    expect(destroyAction.run).toHaveBeenCalled()
  })

  it('retries scheduled destruction for an errored box with an existing destroy intent', async () => {
    const { manager, boxRepository } = createManager()
    const box = createBox('retry-destroy', BoxState.ERROR)
    box.desiredState = BoxDesiredState.DESTROYED
    box.pending = true
    boxRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([box])
    const sync = jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await manager.drainingRunnerBoxesCheck()

    expect(sync).toHaveBeenCalledWith(box.id, false)
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('keeps fresh drain candidates separate from a full destroy-retry batch', async () => {
    const { manager, boxRepository } = createManager()
    const stopped = createBox('fresh-stopped', BoxState.STOPPED)
    const retries = Array.from({ length: 100 }, (_, index) => {
      const box = createBox(`retry-${index}`, BoxState.ERROR)
      box.desiredState = BoxDesiredState.DESTROYED
      box.pending = true
      return box
    })
    boxRepository.find.mockResolvedValueOnce([stopped]).mockResolvedValueOnce(retries)
    jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

    await manager.drainingRunnerBoxesCheck()

    expect(boxRepository.find).toHaveBeenCalledTimes(2)
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(stopped.id, expect.any(Object))
  })

  it('limits concurrent box draining operations', async () => {
    const { manager, boxRepository } = createManager()
    boxRepository.find
      .mockResolvedValueOnce(Array.from({ length: 20 }, (_, index) => createBox(`box-${index}`, BoxState.STOPPED)))
      .mockResolvedValueOnce([])
    let active = 0
    let maxActive = 0
    jest.spyOn(manager as any, 'drainBox').mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
    })

    await manager.drainingRunnerBoxesCheck()

    expect(maxActive).toBe(10)
  })
})
