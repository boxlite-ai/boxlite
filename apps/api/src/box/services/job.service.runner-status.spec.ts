/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ConflictException, NotFoundException } from '@nestjs/common'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobService } from './job.service'

const jobId = '00000000-0000-4000-8000-000000000001'
const missingJobId = '00000000-0000-4000-8000-000000000002'

function makeJob(status: JobStatus): Job {
  const job = new Job({
    id: jobId,
    type: JobType.START_BOX,
    status,
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: 'box-1',
    payload: '{"image":"alpine"}',
  })
  job.resultMetadata = '{"old":true}'
  job.createdAt = new Date('2026-08-10T10:00:00.000Z')
  job.updatedAt = job.createdAt
  job.startedAt = status === JobStatus.PENDING ? null : new Date('2026-08-10T10:00:01.000Z')
  job.completedAt =
    status === JobStatus.COMPLETED || status === JobStatus.FAILED ? new Date('2026-08-10T10:00:02.000Z') : null
  return job
}

function updateRunnerJobStatus(
  service: JobService,
  jobId: string,
  runnerId: string,
  status: JobStatus,
  errorMessage?: string,
  resultMetadata?: string,
): Promise<Job> {
  return service.updateRunnerJobStatus(jobId, runnerId, status, errorMessage, resultMetadata)
}

function makeService(returnedRows: Array<Partial<Job>>, storedJob: Job | null) {
  const entityManager = {
    findOne: jest.fn().mockResolvedValue(storedJob),
    save: jest.fn(async (_entity: unknown, job: Job) => job),
  }
  const jobRepository = {
    query: jest.fn().mockResolvedValue([returnedRows, returnedRows.length]),
    findOneBy: jest.fn().mockResolvedValue(storedJob),
    manager: {
      transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
        callback(entityManager),
      ),
    },
  }
  const jobStateHandlerService = { handleJobCompletion: jest.fn().mockResolvedValue(undefined) }
  const service = new JobService(jobRepository as any, {} as any, jobStateHandlerService as any)
  return { entityManager, jobRepository, jobStateHandlerService, service }
}

describe('JobService.updateRunnerJobStatus', () => {
  it('uses one conditional UPDATE and restores the returned row to a Job', async () => {
    const storedJob = makeJob(JobStatus.IN_PROGRESS)
    const returnedRow = {
      ...makeJob(JobStatus.COMPLETED),
      status: JobStatus.COMPLETED,
      version: 2,
      resultMetadata: '{"exitCode":0}',
    }
    const { entityManager, jobRepository, jobStateHandlerService, service } = makeService([returnedRow], storedJob)

    const updated = await updateRunnerJobStatus(
      service,
      storedJob.id,
      storedJob.runnerId,
      JobStatus.COMPLETED,
      '',
      '{"exitCode":0}',
    )

    expect(updated).toBeInstanceOf(Job)
    expect(updated.getPayload()).toEqual({ image: 'alpine' })
    expect(updated.getResultMetadata()).toEqual({ exitCode: 0 })
    expect(jobRepository.query).toHaveBeenCalledTimes(1)
    const [sql, params] = jobRepository.query.mock.calls[0]
    expect(sql).toContain('UPDATE job AS j')
    expect(sql).toContain('"runnerId"=$2')
    expect(sql).toContain('version=j.version+1')
    expect(sql).toContain('RETURNING j.*')
    expect(sql).toContain('pg_input_is_valid')
    expect(params).toEqual([
      storedJob.id,
      storedJob.runnerId,
      JobStatus.COMPLETED,
      null,
      '{"exitCode":0}',
      expect.any(Date),
    ])
    expect(jobRepository.manager.transaction).not.toHaveBeenCalled()
    expect(jobRepository.findOneBy).not.toHaveBeenCalled()
    expect(entityManager.findOne).not.toHaveBeenCalled()
    expect(jobStateHandlerService.handleJobCompletion).toHaveBeenCalledWith(updated)
  })

  it('hides a job owned by another runner as NotFound', async () => {
    const storedJob = makeJob(JobStatus.IN_PROGRESS)
    const { jobRepository, jobStateHandlerService, service } = makeService([], storedJob)

    await expect(
      updateRunnerJobStatus(service, storedJob.id, 'runner-2', JobStatus.COMPLETED),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(storedJob.status).toBe(JobStatus.IN_PROGRESS)
    expect(jobRepository.query).toHaveBeenCalledTimes(1)
    expect(jobRepository.findOneBy).toHaveBeenCalledWith({ id: storedJob.id })
    expect(jobRepository.findOneBy).toHaveBeenCalledTimes(1)
    expect(jobRepository.manager.transaction).not.toHaveBeenCalled()
    expect(jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
  })

  it('hides a malformed job ID without sending it to PostgreSQL', async () => {
    const { jobRepository, service } = makeService([], null)

    await expect(
      updateRunnerJobStatus(service, 'not-a-uuid', 'runner-1', JobStatus.COMPLETED),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(jobRepository.query).not.toHaveBeenCalled()
    expect(jobRepository.findOneBy).not.toHaveBeenCalled()
  })

  it('distinguishes a missing job from an invalid transition after zero updated rows', async () => {
    const missing = makeService([], null)
    await expect(
      updateRunnerJobStatus(missing.service, missingJobId, 'runner-1', JobStatus.COMPLETED),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(missing.jobRepository.query).toHaveBeenCalledTimes(1)
    expect(missing.jobRepository.findOneBy).toHaveBeenCalledWith({ id: missingJobId })
    expect(missing.jobRepository.findOneBy).toHaveBeenCalledTimes(1)

    const completedJob = makeJob(JobStatus.COMPLETED)
    const conflict = makeService([], completedJob)
    await expect(
      updateRunnerJobStatus(conflict.service, completedJob.id, completedJob.runnerId, JobStatus.FAILED),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(conflict.jobRepository.query).toHaveBeenCalledTimes(1)
    expect(conflict.jobRepository.findOneBy).toHaveBeenCalledWith({ id: completedJob.id })
    expect(conflict.jobRepository.findOneBy).toHaveBeenCalledTimes(1)
    expect(conflict.jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
  })
})
