/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import axios from 'axios'
import { JobDto, JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

jest.mock('axios')
const post = axios.post as jest.Mock

const jobId = '00000000-0000-4000-8000-000000000001'

function directJob(): Job {
  const job = new Job({
    id: jobId,
    type: JobType.CREATE_BOX,
    status: JobStatus.IN_PROGRESS,
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: 'box-1',
    payload: '{"image":"alpine","secretCredential":{"token":"private"}}',
    traceContext: { traceparent: '00-4bf92f3577b34da6c025ce3d2b9d1f-00f067aa0ba902b7-01' },
  })
  job.startedAt = new Date('2026-11-28T04:00:00.000Z')
  job.updatedAt = job.startedAt
  return job
}

function makeAdapter(options: { enabled?: boolean; capabilities?: string[]; state?: RunnerState; apiUrl?: string | null } = {}) {
  const job = directJob()
  const jobService = {
    createJob: jest.fn().mockResolvedValue(job),
    notifyRunner: jest.fn().mockResolvedValue(undefined),
    updateJobStatus: jest.fn(),
    updateRunnerJobStatus: jest.fn(),
    pollJobs: jest.fn(),
  }
  const jobRepository = { findOne: jest.fn(), manager: { transaction: jest.fn() } }
  const adapter = new RunnerAdapterV2({} as any, jobRepository as any, jobService as any)
  Object.assign(adapter, {
    config: {
      get: jest.fn((key: string) => key === 'runnerDirectCreate.enabled' && (options.enabled ?? true)),
    },
  })
  return { adapter, job, jobRepository, jobService }
}

async function initDirectRunner(adapter: RunnerAdapterV2, options: Parameters<typeof makeAdapter>[0] = {}) {
  await adapter.init({
    id: 'runner-1',
    state: options.state ?? RunnerState.READY,
    capabilities: options.capabilities ?? ['direct-create-v1'],
    apiUrl: options.apiUrl === undefined ? 'http://runner.internal:3003' : options.apiUrl,
    apiKey: 'runner-api-key',
  } as any)
}

describe('RunnerAdapterV2 direct CREATE_BOX dispatch', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ status: 202 })
  })

  it.each([
    ['the global switch is off', { enabled: false }],
    ['the runner does not declare direct-create-v1', { capabilities: ['filestore'] }],
    ['the runner is not ready', { state: RunnerState.UNRESPONSIVE }],
    ['the runner has no API URL', { apiUrl: null }],
  ])('retains the original job-only path when %s', async (_label, options) => {
    const { adapter, jobService } = makeAdapter(options)
    await initDirectRunner(adapter, options)

    await adapter.createBox({ id: 'box-1' } as any, 'alpine')

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ image: 'alpine' }),
    )
    expect(post).not.toHaveBeenCalled()
  })

  it('creates IN_PROGRESS once and dispatches the same complete local Job without polling or notifying', async () => {
    const { adapter, job, jobRepository, jobService } = makeAdapter()
    await initDirectRunner(adapter)

    await adapter.createBox({ id: 'box-1' } as any, 'alpine')

    expect(jobService.createJob).toHaveBeenCalledTimes(1)
    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ image: 'alpine' }),
      { direct: true },
    )
    expect(post).toHaveBeenCalledWith(
      `http://runner.internal:3003/internal/jobs/${jobId}/direct-create`,
      new JobDto(job),
      expect.objectContaining({
        headers: { Authorization: 'Bearer runner-api-key' },
        timeout: expect.any(Number),
      }),
    )
    expect(post.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        id: jobId,
        type: JobType.CREATE_BOX,
        status: JobStatus.IN_PROGRESS,
        resourceType: ResourceType.BOX,
        resourceId: 'box-1',
        payload: job.payload,
        traceContext: job.traceContext,
      }),
    )
    expect(jobService.notifyRunner).not.toHaveBeenCalled()
    expect(jobService.pollJobs).not.toHaveBeenCalled()
    expect(jobRepository.findOne).not.toHaveBeenCalled()
  })

  it('keeps the accepted IN_PROGRESS job untouched when direct dispatch fails', async () => {
    const { adapter, job, jobService } = makeAdapter()
    await initDirectRunner(adapter)
    post.mockRejectedValue(Object.assign(new Error('runner unavailable'), { response: { status: 503 } }))

    await expect(adapter.createBox({ id: 'box-1' } as any, 'alpine')).rejects.toThrow(
      `Direct CREATE_BOX dispatch failed for job ${jobId}`,
    )

    expect(job.status).toBe(JobStatus.IN_PROGRESS)
    expect(jobService.notifyRunner).not.toHaveBeenCalled()
    expect(jobService.updateJobStatus).not.toHaveBeenCalled()
    expect(jobService.updateRunnerJobStatus).not.toHaveBeenCalled()
    expect(jobService.createJob).toHaveBeenCalledTimes(1)
  })

  it('dispatches a secret-bearing job only after its transaction commits', async () => {
    const { adapter, job, jobService } = makeAdapter()
    await initDirectRunner(adapter)
    let committed = false
    let issued = false
    const manager = { id: 'transaction-manager' }
    const jobRepository = {
      manager: {
        transaction: jest.fn(async (callback: (manager: unknown) => Promise<Job>) => {
          const result = await callback(manager)
          committed = true
          return result
        }),
      },
    }
    Object.assign(adapter, {
      jobRepository,
      credentials: {
        issue: jest.fn(async () => {
          expect(committed).toBe(false)
          issued = true
          return { token: 'private' }
        }),
      },
      config: {
        get: jest.fn((key: string) => key === 'secretServer.enabled' || key === 'runnerDirectCreate.enabled'),
      },
    })
    jobService.createJob.mockImplementation(async (_manager, _type, _runner, _resource, _resourceId, payload) => {
      expect(issued).toBe(true)
      expect(committed).toBe(false)
      job.payload = JSON.stringify(payload)
      return job
    })
    post.mockImplementation(async () => {
      expect(committed).toBe(true)
      return { status: 202 }
    })

    await adapter.createBox(
      { id: 'box-1', organizationId: 'org-1', secrets: [{ secretId: 'secret-1', name: 'registry' }] } as any,
      'alpine',
    )

    expect(jobRepository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(jobService.createJob).toHaveBeenCalledWith(
      manager,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ secretCredential: { token: 'private' } }),
      { direct: true },
    )
    expect(jobService.notifyRunner).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })
})
