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

  it('uses a distinct create job type for capability overrides', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()

    await adapter.createBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX_WITH_CAPABILITIES_V2,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('uses a distinct recovery job type for capability overrides', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()

    await adapter.recoverBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.RECOVER_BOX_WITH_CAPABILITIES_V2,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('keeps capability-free creates on the legacy job type', async () => {
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
      expect.not.objectContaining({ advanced: expect.anything() }),
    )
  })

  it('keeps capability-free recovery on the legacy job type', async () => {
    const { adapter, jobService } = makeAdapter()
    const box = customCapabilityBox()
    box.advanced = { capabilities: { add: [], drop: [] } }

    await adapter.recoverBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.RECOVER_BOX,
      'runner-1',
      ResourceType.BOX,
      box.id,
      expect.not.objectContaining({ advanced: expect.anything() }),
    )
  })
})
