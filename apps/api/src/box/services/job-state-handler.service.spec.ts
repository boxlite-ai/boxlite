/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobStateHandlerService } from './job-state-handler.service'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'

function buildHarness(state: BoxState) {
  const box = { id: 'box-1', state, desiredState: BoxDesiredState.STARTED }
  const updates: Array<Record<string, unknown>> = []
  const boxRepository: any = {
    findOne: jest.fn().mockResolvedValue(box),
    update: jest.fn(async (_id: string, opts: { updateData: Record<string, unknown> }) => {
      updates.push(opts.updateData)
    }),
  }
  return { service: new JobStateHandlerService(boxRepository, {} as any), updates }
}

function failedJob(type: JobType, errorMessage: string) {
  return {
    id: 'job-1',
    type,
    status: JobStatus.FAILED,
    resourceId: 'box-1',
    errorMessage,
  } as any
}

describe('JobStateHandlerService failed start-intent jobs', () => {
  afterEach(() => jest.clearAllMocks())

  it.each([
    [JobType.CREATE_BOX, BoxState.CREATING, 'Failed to create box'],
    [JobType.START_BOX, BoxState.STARTING, 'Failed to start box'],
    [JobType.RECOVER_BOX, BoxState.ERROR, 'Failed to recover box'],
  ])('marks failed %s as ERROR and withdraws STARTED intent', async (jobType, state, fallbackReason) => {
    const { service, updates } = buildHarness(state)

    await service.handleJobCompletion(failedJob(jobType, fallbackReason))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STOPPED,
    })
  })
})
