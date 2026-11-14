/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ConflictException, Logger } from '@nestjs/common'
import { Job } from '../entities/job.entity'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { JobService } from './job.service'

function makeJob(status: JobStatus): Job {
  return {
    id: 'job-1',
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: 'box-1',
    type: JobType.START_BOX,
    status,
    startedAt: new Date('2026-07-29T04:00:00.000Z'),
    completedAt: status === JobStatus.COMPLETED ? new Date('2026-07-29T04:05:00.000Z') : null,
  } as Job
}

function makeService(transactionalJob: Job) {
  let transactionCommitted = false
  const entityManager = {
    findOne: jest.fn().mockResolvedValue(transactionalJob),
    save: jest.fn(async (_entity: unknown, job: Job) => job),
  }
  const jobRepository = {
    manager: {
      transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) => {
        const result = await callback(entityManager)
        transactionCommitted = true
        return result
      }),
    },
    findOneBy: jest.fn(),
    save: jest.fn(async (job: Job) => job),
  }
  const jobStateHandlerService = {
    handleJobCompletion: jest.fn(() => {
      expect(transactionCommitted).toBe(true)
      return Promise.resolve()
    }),
  }
  const service = new JobService(jobRepository as any, {} as any, jobStateHandlerService as any)
  return { entityManager, jobRepository, jobStateHandlerService, service }
}

describe('JobService creation diagnostics', () => {
  it('logs the job, runner, resource and database code without logging its payload', async () => {
    const failure = Object.assign(new Error('insert failed'), {
      code: '58000',
      query: 'INSERT INTO job VALUES (?)',
      parameters: ['do-not-log'],
    })
    const jobRepository = { insert: jest.fn().mockRejectedValue(failure) }
    const service = new JobService(jobRepository as any, {} as any, {} as any)
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    try {
      await expect(
        service.createJob(null, JobType.CREATE_BOX, 'runner-1', ResourceType.BOX, 'box-1', {
          env: { SECRET: 'do-not-log' },
        }),
      ).rejects.toBe(failure)
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'job.create.failed',
          jobType: JobType.CREATE_BOX,
          runnerId: 'runner-1',
          resourceType: ResourceType.BOX,
          resourceId: 'box-1',
          code: '58000',
          errorName: 'Error',
        }),
        'Job creation failed',
      )
      expect(log.mock.calls[0][0]).not.toHaveProperty('err')
      expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log')
    } finally {
      log.mockRestore()
    }
  })
})

describe('JobService.updateJobStatus transaction boundary', () => {
  it('locks, validates, and saves the Job in one transaction before completion handling', async () => {
    const job = makeJob(JobStatus.IN_PROGRESS)
    const { entityManager, jobRepository, jobStateHandlerService, service } = makeService(job)

    await expect(service.updateJobStatus(job.id, JobStatus.COMPLETED)).resolves.toBe(job)

    expect(jobRepository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(entityManager.findOne).toHaveBeenCalledWith(Job, {
      where: { id: job.id },
      lock: { mode: 'pessimistic_write' },
    })
    expect(entityManager.save).toHaveBeenCalledWith(Job, job)
    expect(jobRepository.findOneBy).not.toHaveBeenCalled()
    expect(jobRepository.save).not.toHaveBeenCalled()
    expect(jobStateHandlerService.handleJobCompletion).toHaveBeenCalledWith(job)
  })

  it('rejects a stale FAILED update when the locked Job was already completed by reconciliation', async () => {
    const lockedJob = makeJob(JobStatus.COMPLETED)
    const staleJob = makeJob(JobStatus.IN_PROGRESS)
    const { entityManager, jobRepository, jobStateHandlerService, service } = makeService(lockedJob)
    jobRepository.findOneBy.mockResolvedValue(staleJob)

    await expect(service.updateJobStatus(lockedJob.id, JobStatus.FAILED, 'stale failure')).rejects.toBeInstanceOf(
      ConflictException,
    )

    expect(jobRepository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(jobRepository.findOneBy).not.toHaveBeenCalled()
    expect(entityManager.save).not.toHaveBeenCalled()
    expect(jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
    expect(lockedJob.status).toBe(JobStatus.COMPLETED)
  })

  it('preserves idempotent completion handling after the transaction commits', async () => {
    const completedJob = makeJob(JobStatus.COMPLETED)
    const originalCompletedAt = completedJob.completedAt
    const { entityManager, jobStateHandlerService, service } = makeService(completedJob)

    await expect(
      service.updateJobStatus(completedJob.id, JobStatus.COMPLETED, undefined, '{"daemonVersion":"new"}'),
    ).resolves.toBe(completedJob)

    expect(entityManager.save).toHaveBeenCalledWith(Job, completedJob)
    expect(completedJob.completedAt).not.toBe(originalCompletedAt)
    expect(completedJob.resultMetadata).toBe('{"daemonVersion":"new"}')
    expect(jobStateHandlerService.handleJobCompletion).toHaveBeenCalledWith(completedJob)
  })
})
