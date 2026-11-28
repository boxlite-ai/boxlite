/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { GUARDS_METADATA } from '@nestjs/common/constants'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { JobDto, JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobAccessGuard } from '../guards/job-access.guard'
import { JobController } from './job.controller'

describe('JobController runner status updates', () => {
  it('keeps class authentication and removes the duplicate job read only from status updates', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, JobController)).toEqual([CombinedAuthGuard, RunnerAuthGuard])
    expect(Reflect.getMetadata(GUARDS_METADATA, JobController.prototype.updateJobStatus) ?? []).not.toContain(
      JobAccessGuard,
    )
    expect(Reflect.getMetadata(GUARDS_METADATA, JobController.prototype.getJob)).toContain(JobAccessGuard)
  })

  it('passes the authenticated runner ID to the runner-facing service method', async () => {
    const job = new Job({
      id: 'job-1',
      type: JobType.START_BOX,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
    })
    const jobService = {
      updateJobStatus: jest.fn().mockResolvedValue(job),
      updateRunnerJobStatus: jest.fn().mockResolvedValue(job),
    }
    const controller = new JobController(jobService as any)
    const runnerContext = { runnerId: 'runner-1' } as RunnerContext
    const update = {
      status: JobStatus.COMPLETED,
      errorMessage: 'runner error',
      resultMetadata: '{"exitCode":0}',
    }

    await expect(controller.updateJobStatus(runnerContext, job.id, update)).resolves.toEqual(new JobDto(job))
    expect(jobService.updateRunnerJobStatus).toHaveBeenCalledWith(
      job.id,
      runnerContext.runnerId,
      update.status,
      update.errorMessage,
      update.resultMetadata,
    )
    expect(jobService.updateJobStatus).not.toHaveBeenCalled()
  })
})
