/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { JobStateHandlerService } from './job-state-handler.service'
import { Job } from '../entities/job.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RedisLockProvider } from '../common/redis-lock.provider'

describe('JobStateHandlerService RESIZE_BOX completion', () => {
  it('does not release a state-change lock acquired after the job was dispatched', async () => {
    let currentOwner: string | null = 'new-request-owner'
    const redis = {
      get: jest.fn(async () => currentOwner),
      eval: jest.fn(async (_script: string, _keys: number, _key: string, owner: string) => {
        if (currentOwner === owner) {
          currentOwner = null
          return 1
        }
        return 0
      }),
    } as any
    const redisLockProvider = new RedisLockProvider(redis)
    const boxRepository = {
      findOne: jest.fn().mockResolvedValue(undefined),
    } as any
    const service = new (JobStateHandlerService as any)(boxRepository, redisLockProvider)
    const job = new Job({
      id: 'job-from-prior-request',
      type: JobType.START_BOX,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
    })

    await service.handleJobCompletion(job)
    await new Promise((resolve) => setImmediate(resolve))

    expect(currentOwner).toBe('new-request-owner')
  })

  it('persists completed V2 resize resources and restores the prior state', async () => {
    const box = {
      id: 'box-1',
      state: BoxState.RESIZING,
      desiredState: BoxDesiredState.STARTED,
      cpu: 2,
      mem: 4,
      disk: 10,
    }
    const boxRepository = {
      findOne: jest.fn().mockResolvedValue(box),
      update: jest.fn().mockResolvedValue(undefined),
    } as any
    const service = new JobStateHandlerService(boxRepository)
    const job = new Job({
      id: 'job-1',
      type: JobType.RESIZE_BOX,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: box.id,
      payload: JSON.stringify({ cpu: 4, memory: 8, disk: 20 }),
    })

    await service.handleJobCompletion(job)

    expect(boxRepository.update).toHaveBeenCalledWith(box.id, {
      updateData: {
        cpu: 4,
        mem: 8,
        disk: 20,
        state: BoxState.STARTED,
      },
      entity: box,
    })
  })
})
