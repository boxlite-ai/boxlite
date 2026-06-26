/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'

describe('RunnerAdapterV2 secret handling', () => {
  it('encrypts create-only secrets in the create-box job payload', async () => {
    const createJob = jest.fn(async () => undefined)
    const encryptionService = {
      encrypt: jest.fn(async (value: string) => `encrypted:${value}`),
    }
    const adapter = new RunnerAdapterV2({} as any, {} as any, { createJob } as any, encryptionService as any)
    await adapter.init({ id: 'runner-1' } as Runner)

    const box = new Box('region-1', 'secret-box')
    box.id = 'box-1'
    box.image = 'boxlite/base'
    box.osUser = 'boxlite'
    box.organizationId = 'org-1'
    box.cpu = 1
    box.mem = 2
    box.disk = 8

    await adapter.createBox(box, undefined, [
      {
        name: 'openai_api_key',
        value: 'sk-test',
        hosts: ['api.openai.com'],
        placeholder: '<BOXLITE_SECRET:openai_api_key>',
      },
    ])

    expect(createJob).toHaveBeenCalledTimes(1)
    const [, type, runnerId, resourceType, resourceId, payload] = createJob.mock.calls[0] as any[]
    expect(type).toBe(JobType.CREATE_BOX)
    expect(runnerId).toBe('runner-1')
    expect(resourceType).toBe(ResourceType.BOX)
    expect(resourceId).toBe('box-1')
    expect(payload.secrets).toEqual([
      {
        name: 'openai_api_key',
        value: 'encrypted:sk-test',
        hosts: ['api.openai.com'],
        placeholder: '<BOXLITE_SECRET:openai_api_key>',
      },
    ])
    expect(encryptionService.encrypt).toHaveBeenCalledWith('sk-test')
  })
})
