/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobStateHandlerService } from './job-state-handler.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'

function buildHarness(box: { id: string; state: BoxState; desiredState: BoxDesiredState }) {
  const updates: Array<{ id: string; updateData: any }> = []
  const boxRepository: any = {
    findOne: jest.fn().mockResolvedValue(box),
    update: jest.fn(async (id: string, opts: { updateData: any }) => {
      updates.push({ id, updateData: opts.updateData })
    }),
  }
  const service = new JobStateHandlerService(boxRepository, {} as any)
  return { service, boxRepository, updates }
}

function failedCreateJob(errorMessage: string) {
  return {
    id: 'job-1',
    type: JobType.CREATE_BOX,
    status: JobStatus.FAILED,
    resourceId: 'box-1',
    errorMessage,
  } as any
}

describe('JobStateHandlerService CREATE_BOX failure handling', () => {
  afterEach(() => jest.clearAllMocks())

  it('converges a split-brain "already exists" CREATE failure to STOPPED, not ERROR', async () => {
    // A prior CREATE_BOX already built this box on the runner; the API never recorded
    // success, so the retry collides on the name and the runner reports "already exists".
    // The box is present, not failed — it must not be stranded in ERROR.
    const { service, updates } = buildHarness({
      id: 'box-1',
      state: BoxState.CREATING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.handleJobCompletion(failedCreateJob("failed to create box: box with name 'box-1' already exists"))

    expect(updates).toHaveLength(1)
    expect(updates[0].updateData.state).toBe(BoxState.STOPPED)
    expect(updates[0].updateData.errorReason).toBeNull()
  })

  it('also treats runner box ID collisions as split-brain create success', async () => {
    const { service, updates } = buildHarness({
      id: 'box-1',
      state: BoxState.CREATING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.handleJobCompletion(failedCreateJob('failed to create box: box box-1 already exists'))

    expect(updates).toHaveLength(1)
    expect(updates[0].updateData.state).toBe(BoxState.STOPPED)
    expect(updates[0].updateData.errorReason).toBeNull()
  })

  it('does not treat unrelated already-exists CREATE errors as box split-brain', async () => {
    const { service, updates } = buildHarness({
      id: 'box-1',
      state: BoxState.CREATING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.handleJobCompletion(failedCreateJob("failed to create box: volume with name 'box-1' already exists"))

    expect(updates).toHaveLength(1)
    expect(updates[0].updateData.state).toBe(BoxState.ERROR)
    expect(updates[0].updateData.errorReason).toContain('volume with name')
  })

  it('still marks a genuine CREATE failure as ERROR', async () => {
    const { service, updates } = buildHarness({
      id: 'box-1',
      state: BoxState.CREATING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.handleJobCompletion(failedCreateJob('engine exited unexpectedly: signal SIGABRT'))

    expect(updates).toHaveLength(1)
    expect(updates[0].updateData.state).toBe(BoxState.ERROR)
  })
})
