/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { ConflictException } from '@nestjs/common'
import { Box } from '../entities/box.entity'
import { JobService } from './job.service'

describe('JobService metering handoff', () => {
  const jobRepository = {
    insert: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {
      transaction: jest.fn(),
      findOne: jest.fn(),
    },
  }
  const redis = { lpush: jest.fn() }
  const jobStateHandler = {
    handleJobCompletion: jest.fn(),
  }
  let service: JobService

  beforeEach(() => {
    jest.clearAllMocks()
    service = new JobService(jobRepository as never, redis as never, jobStateHandler as never)
  })

  it('registers a Box lifecycle job in the same database transaction before notifying the runner', async () => {
    const transactionalJobRepository = { insert: jest.fn().mockResolvedValue(undefined) }
    const transactionalBoxRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'box000000001', runtimeGeneration: 0 }),
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const entityManager = {
      getRepository: jest.fn((entity) => (entity === Box ? transactionalBoxRepository : transactionalJobRepository)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    jobRepository.manager.transaction.mockImplementation(async (callback) => callback(entityManager))
    redis.lpush.mockResolvedValue(1)

    const job = await service.createJob(
      null,
      JobType.START_BOX,
      '00000000-0000-0000-0000-000000000010',
      ResourceType.BOX,
      'box000000001',
    )

    expect(transactionalJobRepository.insert).toHaveBeenCalledWith(job)
    expect(transactionalBoxRepository.update).toHaveBeenCalledWith(
      { id: 'box000000001' },
      { runtimeGeneration: 1, runtimeAuthorized: false },
    )
    expect(job.getPayload()).toMatchObject({ previousRuntimeGeneration: 0, runtimeGeneration: 1 })
    expect(entityManager.update).toHaveBeenCalledWith(Box, { id: 'box000000001' }, { lifecycleJobId: job.id })
    expect(redis.lpush).toHaveBeenCalledWith('runner:jobs:00000000-0000-0000-0000-000000000010', job.id)
    expect(entityManager.update.mock.invocationCallOrder[0]).toBeLessThan(redis.lpush.mock.invocationCallOrder[0])
  })

  it('does not acknowledge a terminal job until Box and metering synchronization succeeds', async () => {
    const job = {
      id: 'job-1',
      type: JobType.START_BOX,
      status: JobStatus.IN_PROGRESS,
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
      completedAt: null,
    }
    const transactionError = new Error('usage period insert failed')
    const entityManager = {
      findOne: jest.fn().mockResolvedValue(job),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      save: jest.fn().mockImplementation(async (_entity, savedJob) => savedJob),
    }
    jobRepository.manager.transaction.mockImplementation(async (callback) => callback(entityManager))
    jobStateHandler.handleJobCompletion.mockRejectedValue(transactionError)

    await expect(service.updateJobStatus(job.id, JobStatus.COMPLETED)).rejects.toBe(transactionError)

    expect(jobStateHandler.handleJobCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, status: JobStatus.COMPLETED }),
    )
  })

  it('accepts an idempotent terminal status retry and repeats synchronization', async () => {
    const job = {
      id: 'job-1',
      type: JobType.START_BOX,
      status: JobStatus.COMPLETED,
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
      completedAt: new Date('2026-07-22T00:00:00.000Z'),
    }
    const entityManager = {
      findOne: jest.fn().mockResolvedValue(job),
      save: jest.fn(),
    }
    jobRepository.manager.transaction.mockImplementation(async (callback) => callback(entityManager))
    jobStateHandler.handleJobCompletion.mockResolvedValue(undefined)

    await expect(service.updateJobStatus(job.id, JobStatus.COMPLETED)).resolves.toMatchObject({
      id: job.id,
      status: JobStatus.COMPLETED,
    })

    expect(jobStateHandler.handleJobCompletion).toHaveBeenCalledTimes(1)
    expect(entityManager.save).not.toHaveBeenCalled()
  })

  it('uses the database clock for a terminal runtime proof timestamp', async () => {
    const databaseNow = new Date('2026-07-22T00:00:03.000Z')
    const job = {
      id: 'job-1',
      type: JobType.START_BOX,
      status: JobStatus.IN_PROGRESS,
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
      completedAt: null,
    }
    const entityManager = {
      findOne: jest.fn().mockResolvedValue(job),
      query: jest.fn().mockResolvedValue([{ now: databaseNow }]),
      save: jest.fn().mockImplementation(async (_entity, savedJob) => savedJob),
    }
    jobRepository.manager.transaction.mockImplementation(async (callback) => callback(entityManager))
    jobStateHandler.handleJobCompletion.mockResolvedValue(undefined)

    await service.updateJobStatus(job.id, JobStatus.COMPLETED)

    expect(job.completedAt).toEqual(databaseNow)
    expect(entityManager.query).toHaveBeenCalledWith('SELECT clock_timestamp() AS "now"')
  })

  it('allows only one of conflicting terminal statuses to win', async () => {
    let persistedStatus = JobStatus.IN_PROGRESS
    const baseJob = {
      id: 'job-1',
      type: JobType.START_BOX,
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
      completedAt: null,
    }
    jest.spyOn(service, 'findOne').mockImplementation(async () => ({ ...baseJob, status: persistedStatus }) as never)
    jobRepository.save.mockImplementation(async (job) => {
      persistedStatus = job.status
      return { ...job }
    })

    const entityManager = {
      findOne: jest.fn().mockImplementation(async () => ({ ...baseJob, status: persistedStatus })),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      save: jest.fn().mockImplementation(async (_entity, job) => {
        persistedStatus = job.status
        return { ...job }
      }),
    }
    let transactionTail = Promise.resolve()
    jobRepository.manager.transaction.mockImplementation((callback) => {
      const result = transactionTail.then(() => callback(entityManager))
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    })
    jobStateHandler.handleJobCompletion.mockResolvedValue(undefined)

    const outcomes = await Promise.allSettled([
      service.updateJobStatus(baseJob.id, JobStatus.COMPLETED),
      service.updateJobStatus(baseJob.id, JobStatus.FAILED),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(jobStateHandler.handleJobCompletion).toHaveBeenCalledTimes(1)
  })

  it('claims a pending job at most once across concurrent pollers', async () => {
    const runnerEpoch = '00000000-0000-4000-8000-000000000001'
    let persistedStatus = JobStatus.PENDING
    const pendingJob = {
      id: 'job-1',
      type: JobType.START_BOX,
      status: JobStatus.PENDING,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
      payload: null,
      traceContext: null,
      errorMessage: null,
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
      updatedAt: new Date('2026-07-22T00:00:00.000Z'),
    }
    jobRepository.find.mockResolvedValue([pendingJob])
    jobRepository.save.mockImplementation(async (job) => ({ ...job }))

    const entityManager = {
      findOne: jest.fn().mockResolvedValue({ runtimeEpoch: runnerEpoch }),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      find: jest
        .fn()
        .mockImplementation(async () =>
          persistedStatus === JobStatus.PENDING ? [{ ...pendingJob, status: persistedStatus }] : [],
        ),
      save: jest.fn().mockImplementation(async (_entity, jobs) => {
        persistedStatus = JobStatus.IN_PROGRESS
        return jobs
      }),
    }
    let transactionTail = Promise.resolve()
    jobRepository.manager.transaction.mockImplementation((callback) => {
      const result = transactionTail.then(() => callback(entityManager))
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    })

    const [first, second] = await Promise.all([
      (service as any).claimPendingJobs('runner-1', 1, runnerEpoch),
      (service as any).claimPendingJobs('runner-1', 1, runnerEpoch),
    ])

    expect(first.length + second.length).toBe(1)
  })

  it('rejects a poll claim when the runner epoch header is missing', async () => {
    const entityManager = {
      findOne: jest.fn(),
      find: jest.fn(),
    }
    jobRepository.manager.transaction.mockImplementation(async (callback) => callback(entityManager))

    await expect((service as any).claimPendingJobs('runner-1', 1)).rejects.toBeInstanceOf(ConflictException)
    expect(entityManager.findOne).not.toHaveBeenCalled()
    expect(entityManager.find).not.toHaveBeenCalled()
  })

  it('returns Job payload only to the current runner process epoch', async () => {
    const runnerEpoch = '00000000-0000-4000-8000-000000000001'
    const job = { id: 'job-1', runnerId: 'runner-1', payload: '{"authToken":"secret"}' }
    jobRepository.manager.findOne.mockResolvedValue({ runtimeEpoch: runnerEpoch })
    jobRepository.findOneBy.mockResolvedValue(job)

    await expect(service.findOneForRunner(job.id, job.runnerId, runnerEpoch)).resolves.toBe(job)
    await expect(service.findOneForRunner(job.id, job.runnerId)).rejects.toBeInstanceOf(ConflictException)
    await expect(
      service.findOneForRunner(job.id, job.runnerId, '00000000-0000-4000-8000-000000000002'),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(jobRepository.findOneBy).toHaveBeenCalledTimes(1)
  })

  it('reconciles a terminal job still referenced by a Box after an interrupted handoff', async () => {
    const job = {
      id: 'job-1',
      type: JobType.STOP_BOX,
      status: JobStatus.FAILED,
      resourceType: ResourceType.BOX,
      resourceId: 'box000000001',
    }
    const builder: Record<string, jest.Mock> = {}
    for (const method of ['innerJoin', 'where', 'andWhere', 'orderBy', 'take']) {
      builder[method] = jest.fn().mockReturnValue(builder)
    }
    builder.getMany = jest.fn().mockResolvedValue([job])
    jobRepository.createQueryBuilder.mockReturnValue(builder)
    jobStateHandler.handleJobCompletion.mockResolvedValue(undefined)

    await service.reconcileTerminalBoxJobs()

    expect(builder.innerJoin).toHaveBeenCalledWith(Box, 'box', 'box."lifecycleJobId" = job.id')
    expect(jobStateHandler.handleJobCompletion).toHaveBeenCalledWith(job)
  })

  it('times out jobs that were never claimed as well as in-progress jobs', async () => {
    jobRepository.find.mockResolvedValue([])

    await service.handleStaleJobs()

    expect(jobRepository.find).toHaveBeenCalled()
    for (const [options] of jobRepository.find.mock.calls) {
      expect(options.where.status._value).toEqual([JobStatus.PENDING, JobStatus.IN_PROGRESS])
    }
  })
})
