/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { BoxService } from './box.service'

const STALL_SECONDS = 60

function makeBox(state: BoxState, desiredState = BoxDesiredState.STARTED): Box {
  const box = new Box('us', 'loader')
  box.state = state
  box.desiredState = desiredState
  box.runnerId = 'runner-1'
  box.pending = true
  return box
}

function makeStalledJob(type: JobType): Job {
  return {
    id: 'job-1',
    runnerId: 'runner-1',
    resourceType: ResourceType.BOX,
    resourceId: 'box-1',
    type,
    status: JobStatus.IN_PROGRESS,
    startedAt: new Date(Date.now() - (STALL_SECONDS + 30) * 1000),
    completedAt: null,
  } as Job
}

type Harness = {
  service: BoxService
  jobFindOne: jest.Mock
  updateJobStatus: jest.Mock
  updateWhere: jest.Mock
}

function createService(box: Box | null, stalledJob: Job | null): Harness {
  const service = Object.create(BoxService.prototype) as BoxService
  const jobFindOne = jest.fn().mockResolvedValue(stalledJob)
  const updateJobStatus = jest.fn().mockResolvedValue(undefined)
  const updateWhere = jest.fn().mockResolvedValue(box)

  ;(service as any).logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }
  ;(service as any).boxRepository = { findOne: jest.fn().mockResolvedValue(box), updateWhere }
  ;(service as any).jobRepository = { findOne: jobFindOne }
  ;(service as any).jobService = { updateJobStatus }
  ;(service as any).configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key !== 'boxSync.startConfirmationStallSeconds') {
        throw new Error(`unexpected config key ${key}`)
      }
      return STALL_SECONDS
    }),
  }

  return { service, jobFindOne, updateJobStatus, updateWhere }
}

describe('BoxService.updateState start reconciliation', () => {
  it('completes the stalled startup job instead of writing the box directly', async () => {
    const box = makeBox(BoxState.CREATING)
    const job = makeStalledJob(JobType.CREATE_BOX)
    const { service, jobFindOne, updateJobStatus, updateWhere } = createService(box, job)

    await service.updateState(box.id, BoxState.STARTED)

    expect(updateJobStatus).toHaveBeenCalledWith('job-1', JobStatus.COMPLETED)
    // The completion handler owns the STARTED transition, the pending flag, the
    // activity stamp and the Redis unlock. Writing the box here too would fork
    // that logic.
    expect(updateWhere).not.toHaveBeenCalled()

    expect(jobFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runnerId: 'runner-1',
          resourceType: ResourceType.BOX,
          resourceId: box.id,
          type: JobType.CREATE_BOX,
          status: JobStatus.IN_PROGRESS,
        }),
      }),
    )
  })

  it('looks for a START_BOX job when the box is STARTING', async () => {
    const box = makeBox(BoxState.STARTING)
    const { service, jobFindOne } = createService(box, makeStalledJob(JobType.START_BOX))

    await service.updateState(box.id, BoxState.STARTED)

    expect(jobFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: JobType.START_BOX }),
      }),
    )
  })

  it('stays silent while the startup job is still progressing', async () => {
    const box = makeBox(BoxState.CREATING)
    const { service, updateJobStatus, updateWhere } = createService(box, null)

    // Not an error: the runner is telling the truth, the job just has not
    // stalled yet. Rejecting would log a 400 on every sync tick.
    await expect(service.updateState(box.id, BoxState.STARTED)).resolves.toBeUndefined()

    expect(updateJobStatus).not.toHaveBeenCalled()
    expect(updateWhere).not.toHaveBeenCalled()
  })

  it('rejects a STARTED report for a box that is no longer desired STARTED', async () => {
    const box = makeBox(BoxState.CREATING, BoxDesiredState.STOPPED)
    const { service, updateJobStatus } = createService(box, makeStalledJob(JobType.CREATE_BOX))

    await expect(service.updateState(box.id, BoxState.STARTED)).rejects.toBeInstanceOf(BadRequestError)
    expect(updateJobStatus).not.toHaveBeenCalled()
  })

  it('still rejects a non-STARTED report for a transitional box', async () => {
    const box = makeBox(BoxState.CREATING)
    const { service, updateJobStatus } = createService(box, makeStalledJob(JobType.CREATE_BOX))

    await expect(service.updateState(box.id, BoxState.STOPPED)).rejects.toBeInstanceOf(BadRequestError)
    expect(updateJobStatus).not.toHaveBeenCalled()
  })
})

describe('BoxService.findByRunnerId state filter', () => {
  function createFinder(): { service: BoxService; find: jest.Mock } {
    const service = Object.create(BoxService.prototype) as BoxService
    const find = jest.fn().mockResolvedValue([])
    ;(service as any).boxRepository = { find }
    return { service, find }
  }

  it('accepts transitional states so a runner can reconcile a lost startup', async () => {
    const { service, find } = createFinder()

    await expect(service.findByRunnerId('runner-1', [BoxState.CREATING, BoxState.STARTING])).resolves.toEqual([])
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('rejects transitional states when asked to skip reconciling boxes', async () => {
    const { service, find } = createFinder()

    // "Skip boxes whose state differs from desired state" is meaningless for a
    // state that has no corresponding desired state — the two requests are
    // mutually exclusive.
    await expect(service.findByRunnerId('runner-1', [BoxState.CREATING], true)).rejects.toBeInstanceOf(BadRequestError)
    expect(find).not.toHaveBeenCalled()
  })
})
