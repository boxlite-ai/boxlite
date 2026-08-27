/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 createBox', () => {
  it('passes secrets through to the CREATE_BOX job payload', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1' } as any)

    const box = {
      id: 'box-1',
      image: 'base',
      osUser: 'boxlite',
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 3,
      volumes: [],
      secrets: [
        { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
      ],
      networkBlockAll: false,
      networkAllowList: undefined,
      authToken: undefined,
      organizationId: undefined,
      region: undefined,
    } as any

    await adapter.createBox(box)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({
        secrets: [
          { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
        ],
      }),
    )
  })
})
