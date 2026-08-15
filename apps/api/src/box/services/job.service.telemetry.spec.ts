/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { Logger as PinoNestLogger } from 'nestjs-pino'
import { JobType, ResourceType } from '../dto/job.dto'
import { JobService } from './job.service'

describe('JobService telemetry logging', () => {
  it('emits tenant correlation fields as top-level structured fields', async () => {
    const debug = jest.fn()
    const adapter = new PinoNestLogger({ debug } as never, {} as never)
    const previousLogger = (Logger as unknown as { staticInstanceRef: unknown }).staticInstanceRef
    Logger.overrideLogger(adapter)

    const service = new JobService({ insert: jest.fn() } as never, { lpush: jest.fn() } as never, {} as never)

    try {
      await service.createJob(null, JobType.CREATE_BOX, 'runner-a', ResourceType.BOX, 'box-a', {
        organizationId: 'org-a',
        runnerId: 'runner-a',
      })
    } finally {
      Logger.overrideLogger(previousLogger as never)
    }

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'JobService',
        msg: expect.stringContaining('Created job'),
        'boxlite.organization.id': 'org-a',
        'boxlite.job.id': expect.any(String),
        'boxlite.runner.id': 'runner-a',
        'boxlite.box.id': 'box-a',
      }),
    )
    expect(debug.mock.calls[0][0]).not.toHaveProperty('boxlite.source')
  })
})
