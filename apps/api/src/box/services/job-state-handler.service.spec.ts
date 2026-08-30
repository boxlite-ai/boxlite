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
      service: new JobStateHandlerService(boxRepository, redisLockProvider, boxMigrationJobReceiver),
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
