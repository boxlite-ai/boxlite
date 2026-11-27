/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Job } from '../entities/job.entity'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { JobService } from './job.service'

function makeClaimedRow(id: string): Job {
  return {
    id,
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: `box-${id}`,
    type: JobType.CREATE_BOX,
    status: JobStatus.IN_PROGRESS,
    payload: JSON.stringify({ image: 'alpine:latest' }),
    traceContext: { traceparent: '00-trace-01' },
    startedAt: new Date('2026-07-30T04:00:01.000Z'),
    completedAt: null,
    createdAt: new Date('2026-07-30T04:00:00.000Z'),
    updatedAt: new Date('2026-07-30T04:00:01.000Z'),
    version: 2,
  } as unknown as Job
}

function makeService(rows: Job[]) {
  const jobRepository = {
    query: jest.fn().mockResolvedValue(rows),
    find: jest.fn().mockResolvedValue(rows),
    update: jest.fn().mockResolvedValue({ raw: rows.map(({ id }) => ({ id })) }),
    create: jest.fn((row: Job) => row),
  }

  const service = new JobService(jobRepository as any, {} as any, {} as any)
  return { service, jobRepository }
}

function claimPendingJobs(service: JobService, runnerId: string, limit: number) {
  return (service as any).claimPendingJobs(runnerId, limit) as Promise<Array<{ id: string; status: JobStatus }>>
}

describe('JobService.claimPendingJobs', () => {
  it('claims and returns jobs in one database statement with row locks and a status guard', async () => {
    const { service, jobRepository } = makeService([makeClaimedRow('job-1')])

    await expect(claimPendingJobs(service, 'runner-1', 10)).resolves.toEqual([
      expect.objectContaining({ id: 'job-1', status: JobStatus.IN_PROGRESS }),
    ])

    expect(jobRepository.query).toHaveBeenCalledTimes(1)
    const [sql, params] = jobRepository.query.mock.calls[0]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("status='PENDING'")
    expect(sql).toContain('version=j.version+1')
    expect(sql).toContain('RETURNING j.*')
    expect(params).toEqual(['runner-1', 10, expect.any(Date)])
    expect(jobRepository.find).not.toHaveBeenCalled()
    expect(jobRepository.update).not.toHaveBeenCalled()
  })

  it('maps raw timestamp, JSON and payload fields without invoking the entity constructor', async () => {
    const rows = [makeClaimedRow('job-1')]
    const { service, jobRepository } = makeService(rows)
    jobRepository.create.mockImplementation(() => new (Job as any)())

    const [claimed] = await claimPendingJobs(service, 'runner-1', 10)

    expect(claimed).toEqual(
      expect.objectContaining({
        id: 'job-1',
        createdAt: '2026-07-30T04:00:00.000Z',
        updatedAt: '2026-07-30T04:00:01.000Z',
        payload: JSON.stringify({ image: 'alpine:latest' }),
        traceContext: { traceparent: '00-trace-01' },
      }),
    )
    expect(jobRepository.create).not.toHaveBeenCalled()
    expect(jobRepository.query).toHaveBeenCalledTimes(1)
  })

  it('preserves the order returned by the ordered claim statement', async () => {
    const { service, jobRepository } = makeService([makeClaimedRow('job-first'), makeClaimedRow('job-second')])

    const claimed = await claimPendingJobs(service, 'runner-1', 10)

    expect(claimed.map((job) => job.id)).toEqual(['job-first', 'job-second'])
    expect(jobRepository.query).toHaveBeenCalledTimes(1)
  })

  it('returns an empty batch without a second read', async () => {
    const { service, jobRepository } = makeService([])

    await expect(claimPendingJobs(service, 'runner-1', 10)).resolves.toEqual([])
    expect(jobRepository.query).toHaveBeenCalledTimes(1)
    expect(jobRepository.find).not.toHaveBeenCalled()
  })

  it('propagates a database failure instead of reporting it as a lost race', async () => {
    const { service, jobRepository } = makeService([])
    jobRepository.query.mockRejectedValueOnce(new Error('deadlock detected'))

    await expect(claimPendingJobs(service, 'runner-1', 10)).rejects.toThrow('deadlock detected')
  })
})
