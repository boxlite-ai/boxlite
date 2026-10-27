/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerService } from './runner.service'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { Box } from '../entities/box.entity'
import { In, Not } from 'typeorm'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { JobStatus } from '../enums/job-status.enum'

describe('RunnerService decommission verification', () => {
  const createService = (boxCount: number, checkCount: string | null = null) => {
    const runner = { id: 'runner-1', draining: true, unschedulable: true, state: RunnerState.READY, apiKey: 'secret' }
    const runnerRepository = {
      find: jest.fn().mockResolvedValue([runner]),
      findOne: jest.fn().mockResolvedValue(runner),
      findOneOrFail: jest.fn().mockResolvedValue(runner),
      save: jest.fn().mockResolvedValue(runner),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const boxRepository = { count: jest.fn().mockResolvedValue(boxCount) }
    // Only the singleton cron guards still take a Redis lock; lifecycle
    // writers serialise against each other with a FOR UPDATE row lock
    // inside `dataSource.transaction`.
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const configService = { getOrThrow: jest.fn().mockReturnValue(1) }
    const redis = {
      get: jest.fn().mockResolvedValue(checkCount),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    }
    // Stands in for the locked read + write the two writers do; `count` here is
    // the transactional re-count, distinct from boxRepository.count outside it.
    const entityManager = {
      findOne: jest.fn().mockResolvedValue(runner),
      count: jest.fn().mockResolvedValue(boxCount),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (_entity: unknown, value: unknown) => value),
      query: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const dataSource = {
      queryResultCache: undefined,
      manager: { count: jest.fn(async (entity: unknown, options?: unknown) => (entity === Box ? boxRepository.count(options) : 0)) },
      transaction: jest.fn(async (cb: (em: typeof entityManager) => Promise<unknown>) => cb(entityManager)),
    }
    const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn() }
    const service = new RunnerService(
      runnerRepository as any,
      {} as any,
      boxRepository as any,
      redisLockProvider as any,
      configService as any,
      {} as any,
      eventEmitter as any,
      dataSource as any,
      redis as any,
    )

    return {
      service,
      runnerRepository,
      boxRepository,
      redisLockProvider,
      redis,
      eventEmitter,
      entityManager,
      dataSource,
    }
  }

  it('resets verification while any box is still assigned to the draining runner', async () => {
    const { service, runnerRepository, boxRepository, redis } = createService(1, '2')

    await (service as any).handleCheckDecommissionRunners()

    expect(boxRepository.count).toHaveBeenCalledWith({ where: { runnerId: 'runner-1' } })
    expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
    expect(runnerRepository.update).not.toHaveBeenCalled()
  })

  it('decommissions only after three checks with no remaining runner assignments', async () => {
    const { service, redis, entityManager } = createService(0, '2')

    await (service as any).handleCheckDecommissionRunners()

    expect(entityManager.update).toHaveBeenCalledWith(Runner, 'runner-1', { state: RunnerState.DECOMMISSIONED })
    expect(redis.del).toHaveBeenCalledWith('runner:draining-check:runner-1')
  })

  it.each([BoxMigration, Job])(
    'keeps a runner while outstanding %p work remains after ownership moved',
    async (entity) => {
      const { service, redis, entityManager, dataSource } = createService(0, '2')
      entityManager.count.mockImplementation(async (target: unknown) => (target === entity ? 1 : 0))
      dataSource.manager.count.mockImplementation(async (target: unknown) => (target === entity ? 1 : 0))

      await (service as any).handleCheckDecommissionRunners()

      expect(entityManager.update).not.toHaveBeenCalled()
      expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
    },
  )

  it.each([BoxMigration, Job])('rechecks outstanding %p work inside the retirement transaction', async (entity) => {
    const { service, redis, entityManager } = createService(0, '2')
    entityManager.count.mockImplementation(async (target: unknown) => (target === entity ? 1 : 0))
    await (service as any).handleCheckDecommissionRunners()
    expect(entityManager.findOne).toHaveBeenCalledWith(
      Runner,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    )
    expect(entityManager.update).not.toHaveBeenCalled()
    expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
  })

  it.each([BoxMigration, Job])('refuses registration deletion while %p work remains', async (entity) => {
    const { service, entityManager } = createService(0)
    entityManager.count.mockImplementation(async (target: unknown) => (target === entity ? 1 : 0))
    await expect(service.remove('runner-1')).rejects.toMatchObject({ status: 428 })
    expect(entityManager.delete).not.toHaveBeenCalled()
  })

  it('reports both migration sides and runnable jobs without returning credentials', async () => {
    const { service, dataSource } = createService(0)
    dataSource.manager.count.mockImplementation(async (entity: unknown) =>
      entity === BoxMigration ? 2 : entity === Job ? 3 : 1,
    )
    expect(await service.getDrainStatus('runner-1')).toEqual({
      id: 'runner-1',
      state: RunnerState.READY,
      draining: true,
      assignedBoxes: 1,
      activeMigrations: 2,
      pendingJobs: 3,
    })
    expect(dataSource.manager.count).toHaveBeenCalledWith(BoxMigration, {
      where: [
        { runnerId: 'runner-1', state: Not(BoxMigrationState.COMPLETED) },
        { box: { runnerId: 'runner-1' }, state: Not(BoxMigrationState.COMPLETED) },
      ],
    })
    expect(dataSource.manager.count).toHaveBeenCalledWith(Job, {
      where: { runnerId: 'runner-1', status: In([JobStatus.PENDING, JobStatus.IN_PROGRESS]) },
    })
  })

  it('deletes an empty unschedulable registration under the runner lock', async () => {
    const { service, entityManager, eventEmitter } = createService(0)
    await service.remove('runner-1')
    expect(entityManager.findOne).toHaveBeenCalledWith(
      Runner,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    )
    expect(entityManager.delete).toHaveBeenCalledWith(Runner, 'runner-1')
    expect(eventEmitter.emitAsync).toHaveBeenCalled()
  })

  it('refuses deletion if scheduling was reenabled before the locked read', async () => {
    const { service, entityManager } = createService(0)
    entityManager.findOne.mockResolvedValue({ id: 'runner-1', unschedulable: false })
    await expect(service.remove('runner-1')).rejects.toMatchObject({ status: 428 })
    expect(entityManager.delete).not.toHaveBeenCalled()
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

  it('does not publish decommission when the transactional re-count still finds a box', async () => {
    const { service, redis, entityManager } = createService(0, '2')
    entityManager.count.mockResolvedValue(1)

    await (service as any).handleCheckDecommissionRunners()

    expect(entityManager.update).not.toHaveBeenCalled()
    expect(redis.set).toHaveBeenCalledWith('runner:draining-check:runner-1', '0', 'EX', 600)
    // The re-count has to happen under the same exclusive lock as the write.
    expect(entityManager.findOne).toHaveBeenCalledWith(
      Runner,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    )
  })

  it('does not decommission when draining is cleared before final verification', async () => {
    const { service, entityManager } = createService(0, '2')
    entityManager.findOne.mockResolvedValue({ id: 'runner-1', draining: false, state: RunnerState.READY })

    await (service as any).handleCheckDecommissionRunners()

    expect(entityManager.count).not.toHaveBeenCalled()
    expect(entityManager.update).not.toHaveBeenCalled()
  })

  it('updates draining under an exclusive lock on the runner row', async () => {
    const { service, entityManager } = createService(0)

    await service.updateDrainingStatus('runner-1', false)

    expect(entityManager.findOne).toHaveBeenCalledWith(
      Runner,
      expect.objectContaining({ where: { id: 'runner-1' }, lock: { mode: 'pessimistic_write' } }),
    )
    expect(entityManager.save).toHaveBeenCalledWith(Runner, expect.objectContaining({ draining: false }))
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

  it('does not emit a stale state event when the guarded health update loses the race', async () => {
    const { service, runnerRepository, eventEmitter } = createService(0)
    runnerRepository.update.mockResolvedValue({ affected: 0 })

    await service.updateRunnerHealth('runner-1')

    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('waits out the row lock rather than capping it', async () => {
    const { service, entityManager } = createService(0, '2')

    await (service as any).handleCheckDecommissionRunners()
    await service.updateDrainingStatus('runner-1', true)

    // No `SET LOCAL lock_timeout`: the only holder either can wait on is the
    // other one, for a single read-modify-write. Assignments take no lock on
    // the runner row, so no create is queued behind this either way.
    expect(entityManager.query).not.toHaveBeenCalled()
  })

  it('translates a missing uncached runner into NotFoundException', async () => {
    const { service, runnerRepository } = createService(0)
    runnerRepository.findOne.mockResolvedValue(null)

    await expect(service.findOneUncachedOrFail('missing')).rejects.toMatchObject({ status: 404 })
  })
})
