/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm'
import { Job } from '../entities/job.entity'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { JobService } from './job.service'

function makePendingJob(id: string): Job {
  return {
    id,
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: `box-${id}`,
    type: JobType.CREATE_BOX,
    status: JobStatus.PENDING,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-07-30T04:00:00.000Z'),
    updatedAt: new Date('2026-07-30T04:00:00.000Z'),
  } as unknown as Job
}

function makeService(pendingJobs: Job[], claimMatches: (id: string) => boolean) {
  const jobRepository = {
    find: jest.fn().mockResolvedValue(pendingJobs),
    update: jest.fn(async () => ({
      affected: pendingJobs.filter((job) => claimMatches(job.id)).length,
      raw: pendingJobs.filter((job) => claimMatches(job.id)).map((job) => ({ id: job.id })),
    })),
    create: jest.fn((row: Job) => row),
    save: jest.fn(),
  }

  const service = new JobService(jobRepository as any, {} as any, {} as any)
  return { service, jobRepository }
}

// claimPendingJobs is private; poll routing is exercised elsewhere.
function claimPendingJobs(service: JobService, runnerId: string, limit: number) {
  return (service as any).claimPendingJobs(runnerId, limit) as Promise<Array<{ id: string; status: JobStatus }>>
}

describe('JobService.claimPendingJobs', () => {
  it('does not reconstruct a returned database row through the entity constructor', async () => {
    const jobs = [makePendingJob('job-1')]
    const { service, jobRepository } = makeService(jobs, () => true)

    // EntityManager.create() invokes `new Job()` without arguments even when
    // entitySkipConstructor is enabled for database deserialization. Job's
    // constructor requires params, so claim must reuse the entity read above.
    jobRepository.create.mockImplementation(() => new (Job as any)())

    await expect(claimPendingJobs(service, 'runner-1', 10)).resolves.toEqual([
      expect.objectContaining({ id: 'job-1', status: JobStatus.IN_PROGRESS }),
    ])
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('claims each job with a status predicate so a concurrent poll cannot claim it twice', async () => {
    const jobs = [makePendingJob('job-1')]
    const { service, jobRepository } = makeService(jobs, () => true)

    const claimed = await claimPendingJobs(service, 'runner-1', 10)

    expect(claimed).toHaveLength(1)
    expect(claimed[0].status).toBe(JobStatus.IN_PROGRESS)

    expect(jobRepository.update).toHaveBeenCalledWith(
      { id: In(['job-1']), status: JobStatus.PENDING },
      expect.objectContaining({ status: JobStatus.IN_PROGRESS }),
      { returning: ['id'] },
    )
  })

  it('skips a job another poll already claimed instead of handing it out again', async () => {
    const jobs = [makePendingJob('job-taken'), makePendingJob('job-free')]
    const { service } = makeService(jobs, (id) => id === 'job-free')

    const claimed = await claimPendingJobs(service, 'runner-1', 10)

    expect(claimed.map((job) => job.id)).toEqual(['job-free'])
  })

  it('propagates a database failure instead of reporting it as a lost race', async () => {
    const jobs = [makePendingJob('job-1')]
    const { service, jobRepository } = makeService(jobs, () => true)
    jobRepository.update.mockRejectedValueOnce(new Error('deadlock detected'))

    await expect(claimPendingJobs(service, 'runner-1', 10)).rejects.toThrow('deadlock detected')
  })
})
