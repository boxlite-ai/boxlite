/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { JobStateHandlerService } from './job-state-handler.service'
import { Job } from '../entities/job.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { getStateChangeLockKey } from '../utils/lock-key.util'

describe('JobStateHandlerService migration job routing', () => {
  function makeService() {
    const boxRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    } as any
    const redisLockProvider = {
      unlock: jest.fn().mockResolvedValue(undefined),
    } as any
    const boxMigrationJobReceiver = {
      handleJobCompletion: jest.fn().mockResolvedValue(undefined),
    } as any
    return {
      service: new JobStateHandlerService(boxRepository, redisLockProvider, boxMigrationJobReceiver, {
        reasonFor: jest.fn(async (_box: unknown, reason: string) => reason),
      } as any),
      redisLockProvider,
      boxMigrationJobReceiver,
    }
  }

  // A migration job holds its own per-job lock and never the box's state-change
  // lock, so releasing that lock here would drop one a concurrent start or stop
  // of the same box is holding.
  it.each([
    JobType.EXPORT_BOX,
    JobType.IMPORT_BOX,
    JobType.ROLLBACK_EXPORT_BOX,
    JobType.ROLLBACK_IMPORT_BOX,
    JobType.DISCARD_EXPORTED_BOX,
  ])('hands %s to the migration receiver and leaves the box state-change lock alone', async (type) => {
    const h = makeService()
    const job = new Job({
      id: 'job-1',
      type,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
    })

    await h.service.handleJobCompletion(job)

    expect(h.boxMigrationJobReceiver.handleJobCompletion).toHaveBeenCalledWith(job)
    expect(h.redisLockProvider.unlock).not.toHaveBeenCalledWith(getStateChangeLockKey('box-1'))
  })

  it('still releases the state-change lock for a box lifecycle job', async () => {
    const h = makeService()
    const job = new Job({
      id: 'job-2',
      type: JobType.STOP_BOX,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
    })

    await h.service.handleJobCompletion(job)

    expect(h.boxMigrationJobReceiver.handleJobCompletion).not.toHaveBeenCalled()
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getStateChangeLockKey('box-1'))
  })
})

describe('JobStateHandlerService failed pulls', () => {
  const BOX = { id: 'box-1', organizationId: 'org-1', image: 'quay.io/acme/app:v1', desiredState: 'started' }

  function makeService() {
    const boxRepository = {
      findOne: jest.fn().mockResolvedValue({ ...BOX }),
      update: jest.fn().mockResolvedValue(undefined),
    } as any
    const imagePullFailureService = {
      reasonFor: jest.fn(async (_box: unknown, reason: string) => `explained: ${reason}`),
    }
    const service = new JobStateHandlerService(
      boxRepository,
      { unlock: jest.fn().mockResolvedValue(undefined) } as any,
      { handleJobCompletion: jest.fn() } as any,
      imagePullFailureService as any,
    )
    return { service, boxRepository, imagePullFailureService }
  }

  const failed = (type: JobType) =>
    new Job({
      id: 'job-1',
      type,
      status: JobStatus.FAILED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: BOX.id,
      errorMessage: 'failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown',
    })

  /**
   * Both are where a box pulls its image: creating, and starting one that was
   * created without starting. A failure in either records the explained reason.
   */
  it.each([JobType.CREATE_BOX, JobType.START_BOX])('records the explained reason for a failed %s', async (type) => {
    const h = makeService()

    await h.service.handleJobCompletion(failed(type))

    expect(h.imagePullFailureService.reasonFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: BOX.id, image: BOX.image }),
      'failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown',
    )
    expect(h.boxRepository.update).toHaveBeenCalledWith(
      BOX.id,
      expect.objectContaining({
        updateData: expect.objectContaining({
          errorReason: 'explained: failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown',
        }),
      }),
    )
  })

  it('leaves a failed stop alone, since stopping pulls nothing', async () => {
    const h = makeService()
    h.boxRepository.findOne.mockResolvedValue({ ...BOX, desiredState: 'stopped' })

    await h.service.handleJobCompletion(failed(JobType.STOP_BOX))

    expect(h.imagePullFailureService.reasonFor).not.toHaveBeenCalled()
  })
})
