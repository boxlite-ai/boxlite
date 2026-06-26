/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobService } from './job.service'
import { Job } from '../entities/job.entity'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'

describe('JobService secret handling', () => {
  it('decrypts create-box secret values before returning jobs to the runner', async () => {
    const service = Object.create(JobService.prototype) as JobService
    ;(service as any).encryptionService = {
      decrypt: jest.fn(async (value: string) => value.replace('encrypted:', '')),
    }

    const job = new Job({
      type: JobType.CREATE_BOX,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
      status: JobStatus.IN_PROGRESS,
      payload: JSON.stringify({
        id: 'box-1',
        secrets: [
          {
            name: 'openai_api_key',
            value: 'encrypted:sk-test',
            hosts: ['api.openai.com'],
            placeholder: '<BOXLITE_SECRET:openai_api_key>',
          },
        ],
      }),
    })

    const dto = await (service as any).toRunnerJobDto(job)

    expect(JSON.parse(dto.payload).secrets).toEqual([
      {
        name: 'openai_api_key',
        value: 'sk-test',
        hosts: ['api.openai.com'],
        placeholder: '<BOXLITE_SECRET:openai_api_key>',
      },
    ])
    expect((service as any).encryptionService.decrypt).toHaveBeenCalledWith('encrypted:sk-test')
  })
})
