/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeService } from './volume.service'

function makeService() {
  const volumeRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (volume: Volume) => volume),
  }
  const organizationService = {
    assertOrganizationIsNotSuspended: jest.fn(),
  }
  const configService = {
    get: jest.fn(),
  }

  const service = new VolumeService(
    volumeRepository as any,
    {} as any,
    organizationService as any,
    configService as any,
    {} as any,
  )

  return { service, volumeRepository, organizationService, configService }
}


describe('VolumeService.resolveReadyVolumes', () => {
  it('returns requested volumes in request order and accepts ids or names', async () => {
    const { service, volumeRepository } = makeService()
    const byId = Object.assign(new Volume(), {
      id: 'volume-id-1',
      name: 'data',
      state: VolumeState.READY,
    })
    const byName = Object.assign(new Volume(), {
      id: 'volume-id-2',
      name: 'cache',
      state: VolumeState.READY,
    })
    volumeRepository.find.mockResolvedValue([byName, byId])

    await expect(service.resolveReadyVolumes('org-1', ['volume-id-1', 'cache'])).resolves.toEqual([byId, byName])
  })

  it('rejects missing and non-ready volumes', async () => {
    const { service, volumeRepository } = makeService()
    volumeRepository.find.mockResolvedValue([])

    await expect(service.resolveReadyVolumes('org-1', ['missing'])).rejects.toBeInstanceOf(NotFoundException)

    volumeRepository.find.mockResolvedValue([
      Object.assign(new Volume(), { id: 'volume-id-1', name: 'data', state: VolumeState.PENDING_CREATE }),
    ])

    await expect(service.resolveReadyVolumes('org-1', ['volume-id-1'])).rejects.toBeInstanceOf(BadRequestError)
  })
})
