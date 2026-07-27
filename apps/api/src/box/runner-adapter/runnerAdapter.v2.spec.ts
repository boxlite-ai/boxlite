/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 capability propagation', () => {
  function makeAdapter() {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) }
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService as any)
    adapter.init({ id: 'runner-1' } as any)
    return { adapter, jobService }
  }

  function customCapabilityBox() {
    const box = new Box('region-1', 'cap-box')
    Object.assign(box as any, {
      image: 'alpine:latest',
      organizationId: 'org-1',
      osUser: 'boxlite',
      advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
    })
    return box
  }

  it('forwards the capability policy on the create job', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()

    await adapter.createBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('forwards the capability policy on the recovery job', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()

    await adapter.recoverBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.RECOVER_BOX,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('sends an empty policy for a box without capability overrides', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()
    box.advanced = { capabilities: { add: [], drop: [] } }

    await adapter.createBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.objectContaining({ advanced: { capabilities: { add: [], drop: [] } } }),
    )
  })
})
