// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { JobAccessGuard } from './job-access.guard'
import { JobService } from '../services/job.service'

describe('JobAccessGuard', () => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ params: { jobId: 'job' }, user: { role: 'runner', runnerId: 'r1' } }),
    }),
  } as ExecutionContext

  it('preserves lookup failures so startup recovery can retry', async () => {
    const outage = new Error('database unavailable')
    const guard = new JobAccessGuard({ findOne: jest.fn().mockRejectedValue(outage) } as unknown as JobService)
    await expect(guard.canActivate(context)).rejects.toBe(outage)
  })

  it.each([null, { runnerId: 'another runner' }])('conceals absent or unowned jobs', async (job) => {
    const guard = new JobAccessGuard({ findOne: jest.fn().mockResolvedValue(job) } as unknown as JobService)
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
  })
})
