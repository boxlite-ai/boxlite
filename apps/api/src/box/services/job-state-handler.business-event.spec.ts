/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobStateHandlerService } from './job-state-handler.service'
import { Job } from '../entities/job.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'

jest.mock('../../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

describe('JobStateHandlerService business events', () => {
  function makeService(
    desiredState: BoxDesiredState,
    update = jest.fn().mockResolvedValue(undefined),
    organizationId = 'org-1',
  ) {
    const box = { id: 'box-1', organizationId, desiredState }
    const boxRepository = { findOne: jest.fn().mockResolvedValue(box), update } as any
    const redisLockProvider = { unlock: jest.fn().mockResolvedValue(undefined) } as any
    return new JobStateHandlerService(boxRepository, redisLockProvider, {} as any)
  }

  function job(type: JobType, status: JobStatus, errorMessage?: string): Job {
    return new Job({
      id: 'job-1',
      type,
      status,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
      errorMessage,
    })
  }

  beforeEach(() => jest.mocked(recordBusinessEvent).mockClear())

  it('records a failed CREATE_BOX job as a box.create exception', async () => {
    const service = makeService(BoxDesiredState.STARTED)

    await service.handleJobCompletion(job(JobType.CREATE_BOX, JobStatus.FAILED, 'image pull failed'))

    expect(recordBusinessEvent).toHaveBeenCalledWith({
      name: 'box.create',
      outcome: 'exception',
      correlationId: 'box-1',
      orgId: 'org-1',
      exceptionType: 'runner_job_failed',
    })
  })

  it('records a completed DESTROY_BOX job as a box.delete success', async () => {
    const service = makeService(BoxDesiredState.DESTROYED)

    await service.handleJobCompletion(job(JobType.DESTROY_BOX, JobStatus.COMPLETED))

    expect(recordBusinessEvent).toHaveBeenCalledWith({
      name: 'box.delete',
      outcome: 'success',
      correlationId: 'box-1',
      orgId: 'org-1',
    })
  })

  it('records a completed STOP_BOX job as a box.stop success', async () => {
    const service = makeService(BoxDesiredState.STOPPED)

    await service.handleJobCompletion(job(JobType.STOP_BOX, JobStatus.COMPLETED))

    expect(recordBusinessEvent).toHaveBeenCalledWith({
      name: 'box.stop',
      outcome: 'success',
      correlationId: 'box-1',
      orgId: 'org-1',
    })
  })

  // Top-up stock has no requested event; its box.create pair is recorded when it is claimed.
  it('records nothing for a warm-pool top-up CREATE_BOX job', async () => {
    const service = makeService(
      BoxDesiredState.STARTED,
      jest.fn().mockResolvedValue(undefined),
      BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
    )

    await service.handleJobCompletion(job(JobType.CREATE_BOX, JobStatus.COMPLETED))

    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  // The event claims the outcome was persisted, so a failed write must not emit it.
  it('records nothing when the box row cannot be written', async () => {
    const service = makeService(BoxDesiredState.STARTED, jest.fn().mockRejectedValue(new Error('conflict')))

    await service.handleJobCompletion(job(JobType.CREATE_BOX, JobStatus.COMPLETED))

    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })
})
