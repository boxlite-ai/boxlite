/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxConflictError } from '../errors/box-conflict.error'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobStateHandlerService } from './job-state-handler.service'
import { RuntimeStartFinalizationStatus } from './runtime-lease.service'

function createJob(overrides: Record<string, unknown> = {}) {
  const job = {
    id: 'job-1',
    type: JobType.START_BOX,
    status: JobStatus.COMPLETED,
    resourceType: ResourceType.BOX,
    resourceId: 'box000000001',
    payload: null as string | null,
    errorMessage: null,
    getResultMetadata: jest.fn().mockReturnValue(null),
    ...overrides,
  }
  return {
    ...job,
    getPayload: jest.fn(() => (job.payload ? JSON.parse(job.payload) : null)),
  }
}

describe('JobStateHandlerService', () => {
  const boxRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
  }
  const runtimeLeaseService = {
    finalizeStartedJob: jest.fn(),
  }
  let service: JobStateHandlerService

  beforeEach(() => {
    jest.clearAllMocks()
    boxRepository.findOne.mockReset()
    boxRepository.update.mockReset()
    runtimeLeaseService.finalizeStartedJob.mockReset().mockResolvedValue(RuntimeStartFinalizationStatus.CONFIRMED)
    service = new JobStateHandlerService(boxRepository as never, runtimeLeaseService as never)
  })

  it('propagates a Box transaction failure so the lifecycle callback can retry', async () => {
    const transactionError = new Error('usage period insert failed')
    boxRepository.findOne.mockResolvedValue({
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STOPPED,
      lifecycleJobId: 'job-1',
    })
    runtimeLeaseService.finalizeStartedJob.mockRejectedValue(transactionError)

    await expect(service.handleJobCompletion(createJob() as never)).rejects.toBe(transactionError)
  })

  it('persists resized resources so BoxRepository can cut the metering period', async () => {
    const box = {
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.RESIZING,
      cpu: 2,
      mem: 4,
      disk: 10,
      lifecycleJobId: 'job-1',
    }
    boxRepository.findOne.mockResolvedValue(box)
    boxRepository.update.mockResolvedValue({ ...box, state: BoxState.STARTED, cpu: 4, mem: 8, disk: 20 })

    await service.handleJobCompletion(
      createJob({
        type: JobType.RESIZE_BOX,
        payload: JSON.stringify({ cpu: 4, memory: 8, disk: 20 }),
      }) as never,
    )

    expect(boxRepository.update).toHaveBeenCalledWith('box000000001', {
      entity: box,
      updateData: {
        cpu: 4,
        mem: 8,
        disk: 20,
        lifecycleJobId: null,
        state: BoxState.STARTED,
      },
    })
  })

  it('ignores a stale terminal replay without changing the current lifecycle operation', async () => {
    boxRepository.findOne.mockResolvedValue({
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTING,
      lifecycleJobId: 'newer-job',
    })

    await expect(service.handleJobCompletion(createJob({ id: 'old-job' }) as never)).resolves.toBeUndefined()

    expect(boxRepository.update).not.toHaveBeenCalled()
  })

  it('treats a lifecycle conflict as an idempotent replay when another callback already cleared ownership', async () => {
    const ownedBox = {
      id: 'box000000001',
      desiredState: BoxDesiredState.STOPPED,
      state: BoxState.STOPPING,
      lifecycleJobId: 'job-1',
    }
    boxRepository.findOne
      .mockResolvedValueOnce(ownedBox)
      .mockResolvedValueOnce({ ...ownedBox, state: BoxState.STOPPED, lifecycleJobId: null })
    boxRepository.update.mockRejectedValueOnce(new BoxConflictError())

    await expect(service.handleJobCompletion(createJob({ type: JobType.STOP_BOX }) as never)).resolves.toBeUndefined()

    expect(boxRepository.update).toHaveBeenCalledTimes(1)
  })

  it('propagates a lifecycle conflict while the same job still owns the Box', async () => {
    const ownedBox = {
      id: 'box000000001',
      desiredState: BoxDesiredState.STOPPED,
      state: BoxState.STOPPING,
      lifecycleJobId: 'job-1',
    }
    const conflict = new BoxConflictError()
    boxRepository.findOne.mockResolvedValue(ownedBox)
    boxRepository.update.mockRejectedValueOnce(conflict)

    await expect(service.handleJobCompletion(createJob({ type: JobType.STOP_BOX }) as never)).rejects.toBe(conflict)
  })

  it('leaves a completed start unapproved when its runtime confirmation is not yet valid', async () => {
    const box = {
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTING,
      runtimeAuthorized: false,
      lifecycleJobId: 'job-1',
    }
    boxRepository.findOne.mockResolvedValue(box)
    runtimeLeaseService.finalizeStartedJob.mockResolvedValue(RuntimeStartFinalizationStatus.WAITING)

    await expect(service.handleJobCompletion(createJob() as never)).rejects.toThrow(
      'Runtime confirmation is not yet valid',
    )

    expect(boxRepository.update).not.toHaveBeenCalled()
  })

  it('leaves a completed start unapproved when runtime confirmation fails', async () => {
    const confirmationError = new Error('runtime lease write failed')
    boxRepository.findOne.mockResolvedValue({
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTING,
      runtimeAuthorized: false,
      lifecycleJobId: 'job-1',
    })
    runtimeLeaseService.finalizeStartedJob.mockRejectedValue(confirmationError)

    await expect(service.handleJobCompletion(createJob() as never)).rejects.toBe(confirmationError)
    expect(boxRepository.update).not.toHaveBeenCalled()
  })

  it('accepts a rejected runtime proof after the lease service atomically converges the Box', async () => {
    boxRepository.findOne.mockResolvedValue({
      id: 'box000000001',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTING,
      runtimeAuthorized: false,
      lifecycleJobId: 'job-1',
    })
    runtimeLeaseService.finalizeStartedJob.mockResolvedValue(RuntimeStartFinalizationStatus.REJECTED)

    await expect(service.handleJobCompletion(createJob() as never)).resolves.toBeUndefined()
    expect(boxRepository.update).not.toHaveBeenCalled()
  })
})
