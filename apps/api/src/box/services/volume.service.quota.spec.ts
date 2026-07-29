/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { VolumeService } from './volume.service'
import { VolumeState } from '../enums/volume-state.enum'
import { DEFAULT_ORG_QUOTA } from '../../organization/services/org-quota'
import { VOLUME_STATES_CONSUMING_STORAGE } from '../../organization/constants/volume-consuming-states.constant'

const ORGANIZATION = { id: 'org-1' } as never

function makeService(overrides: { liveVolumes?: number; maxVolumes?: number } = {}) {
  const { liveVolumes = 0, maxVolumes = 3 } = overrides

  const volumeRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(liveVolumes),
    save: jest.fn().mockImplementation(async (volume) => volume),
  }
  const organizationService = { assertOrganizationIsNotSuspended: jest.fn() }
  const configService = { get: jest.fn().mockReturnValue('http://s3.local') }
  const redisLockProvider = {
    waitForLock: jest.fn().mockResolvedValue(undefined),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const organizationUsageService = {
    getQuotaLimits: jest.fn().mockResolvedValue({ ...DEFAULT_ORG_QUOTA, maxVolumes }),
  }

  const service = new VolumeService(
    volumeRepository as never,
    {} as never, // boxRepository — unused by create()
    organizationService as never,
    configService as never,
    redisLockProvider as never,
    organizationUsageService as never,
  )

  return { service, volumeRepository, redisLockProvider, organizationUsageService }
}

describe('VolumeService.create quota enforcement', () => {
  it('creates a volume when the organization is under its ceiling', async () => {
    const { service, volumeRepository } = makeService({ liveVolumes: 2, maxVolumes: 3 })

    const volume = await service.create(ORGANIZATION, { name: 'v1' } as never)

    expect(volume.name).toBe('v1')
    expect(volume.state).toBe(VolumeState.PENDING_CREATE)
    expect(volumeRepository.save).toHaveBeenCalledTimes(1)
  })

  it('rejects the create that would exceed the ceiling, and persists nothing', async () => {
    const { service, volumeRepository } = makeService({ liveVolumes: 3, maxVolumes: 3 })

    await expect(service.create(ORGANIZATION, { name: 'v4' } as never)).rejects.toThrow(BadRequestException)
    await expect(service.create(ORGANIZATION, { name: 'v4' } as never)).rejects.toThrow(/volume limit exceeded/)
    expect(volumeRepository.save).not.toHaveBeenCalled()
  })

  it('counts only volumes that still occupy storage', async () => {
    const { service, volumeRepository } = makeService()

    await service.create(ORGANIZATION, { name: 'v1' } as never)

    expect(volumeRepository.count).toHaveBeenCalledTimes(1)
    const where = volumeRepository.count.mock.calls[0][0].where
    expect(where.organizationId).toBe('org-1')
    // In(...) keeps its operand list on `value`
    expect(where.state.value).toEqual(VOLUME_STATES_CONSUMING_STORAGE)
    expect(where.state.value).not.toContain(VolumeState.DELETED)
    expect(where.state.value).not.toContain(VolumeState.ERROR)
  })

  it('holds a per-organization lock across the count-check-insert window', async () => {
    const { service, redisLockProvider, volumeRepository } = makeService()
    const order: string[] = []
    redisLockProvider.waitForLock.mockImplementation(async () => void order.push('lock'))
    volumeRepository.count.mockImplementation(async () => {
      order.push('count')
      return 0
    })
    volumeRepository.save.mockImplementation(async (volume) => {
      order.push('save')
      return volume
    })
    redisLockProvider.unlock.mockImplementation(async () => void order.push('unlock'))

    await service.create(ORGANIZATION, { name: 'v1' } as never)

    expect(order).toEqual(['lock', 'count', 'save', 'unlock'])
    expect(redisLockProvider.waitForLock).toHaveBeenCalledWith('org:org-1:volume-quota', 60)
  })

  it('releases the lock when the quota check rejects', async () => {
    const { service, redisLockProvider } = makeService({ liveVolumes: 99 })

    await expect(service.create(ORGANIZATION, { name: 'v1' } as never)).rejects.toThrow(BadRequestException)

    expect(redisLockProvider.unlock).toHaveBeenCalledWith('org:org-1:volume-quota')
  })

  it('falls back to the default ceiling for an organization with no quota row', async () => {
    const { service, organizationUsageService, volumeRepository } = makeService()
    organizationUsageService.getQuotaLimits.mockResolvedValue(DEFAULT_ORG_QUOTA)
    volumeRepository.count.mockResolvedValue(DEFAULT_ORG_QUOTA.maxVolumes)

    await expect(service.create(ORGANIZATION, { name: 'v1' } as never)).rejects.toThrow(
      new RegExp(`max ${DEFAULT_ORG_QUOTA.maxVolumes}`),
    )
  })
})
