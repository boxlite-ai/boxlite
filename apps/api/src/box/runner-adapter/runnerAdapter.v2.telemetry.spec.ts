/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 telemetry context', () => {
  const boxRepository = { findOne: jest.fn() }
  const jobRepository = {}
  const jobService = { createJob: jest.fn() }
  const adapter = new RunnerAdapterV2(boxRepository as never, jobRepository as never, jobService as never)

  beforeEach(async () => {
    jest.clearAllMocks()
    boxRepository.findOne.mockResolvedValue({ organizationId: 'org-a' })
    jobService.createJob.mockResolvedValue({})
    await adapter.init({ id: 'runner-a' } as never)
  })

  it('includes organization and logical runner IDs in lifecycle job payloads', async () => {
    await adapter.stopBox('box-a', true)

    expect(boxRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'box-a' }, select: ['organizationId'] }),
    )
    expect(jobService.createJob).toHaveBeenCalledWith(null, JobType.STOP_BOX, 'runner-a', ResourceType.BOX, 'box-a', {
      force: true,
      organizationId: 'org-a',
      runnerId: 'runner-a',
    })
  })
})
