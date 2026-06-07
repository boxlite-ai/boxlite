/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { SandboxController } from './sandbox.controller'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { SystemRole } from '../../user/enums/system-role.enum'
import { SavedImageController } from './saved-image.controller'
import { SavedImageSortDirection, SavedImageSortField } from '../dto/list-saved-images-query.dto'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function redisMock() {
  return {
    duplicate: jest.fn(() => ({
      subscribe: jest.fn(),
      on: jest.fn(),
    })),
  }
}

describe('SavedImageController', () => {
  it('publishes savedImages under the /saved-images route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SavedImageController)).toBe('saved-images')
  })

  it('rejects non-admin users before changing a saved image general status', async () => {
    const savedImageService = {
      setSavedImageGeneralStatus: jest.fn(),
    }
    const controller = new SavedImageController(savedImageService as any, {} as any)

    await expect(
      controller.setSavedImageGeneralStatus({ role: SystemRole.USER } as any, 'saved-image-id', { general: true } as any),
    ).rejects.toThrow('Insufficient permissions for changing saved image general status')

    expect(savedImageService.setSavedImageGeneralStatus).not.toHaveBeenCalled()
  })

  it('returns system savedImage list when no pagination query is present', async () => {
    const savedImage = createSavedImage()
    const savedImageService = {
      getSystemSavedImages: jest.fn().mockResolvedValue([savedImage]),
      getAllSavedImages: jest.fn(),
    }
    const controller = new SavedImageController(savedImageService as any, {} as any)

    const result = await controller.listSavedImages(
      { organizationId: 'org-id' } as any,
      { page: 1, limit: 100 } as any,
      { query: {} },
    )

    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([expect.objectContaining({ id: 'saved-image-id', name: 'ubuntu:24.04' })])
    expect(savedImageService.getSystemSavedImages).toHaveBeenCalledWith('org-id')
    expect(savedImageService.getAllSavedImages).not.toHaveBeenCalled()
  })

  it('returns paginated savedImages when a pagination query is present', async () => {
    const savedImage = createSavedImage()
    const savedImageService = {
      getSystemSavedImages: jest.fn(),
      getAllSavedImages: jest.fn().mockResolvedValue({
        items: [savedImage],
        total: 1,
        page: 1,
        totalPages: 1,
      }),
    }
    const controller = new SavedImageController(savedImageService as any, {} as any)

    const result = await controller.listSavedImages(
      { organizationId: 'org-id' } as any,
      {
        page: 1,
        limit: 100,
        sort: SavedImageSortField.LAST_USED_AT,
        order: SavedImageSortDirection.DESC,
      } as any,
      { query: { page: '1' } },
    )

    expect(result).toEqual({
      items: [expect.objectContaining({ id: 'saved-image-id', name: 'ubuntu:24.04' })],
      total: 1,
      page: 1,
      totalPages: 1,
    })
    expect(savedImageService.getSystemSavedImages).not.toHaveBeenCalled()
    expect(savedImageService.getAllSavedImages).toHaveBeenCalledWith(
      'org-id',
      1,
      100,
      { name: undefined },
      { field: SavedImageSortField.LAST_USED_AT, direction: SavedImageSortDirection.DESC },
    )
  })
})

function createSavedImage() {
  const now = new Date('2026-01-01T00:00:00.000Z')

  return {
    id: 'saved-image-id',
    organizationId: undefined,
    general: true,
    name: 'ubuntu:24.04',
    imageName: 'ubuntu:24.04',
    artifactRef: 'registry.local/ubuntu:24.04',
    state: SavedImageState.ACTIVE,
    errorReason: undefined,
    cpu: 1,
    gpu: 0,
    mem: 1,
    disk: 3,
    buildInfo: undefined,
    initialRunnerId: undefined,
    savedImageRegions: [],
    createdAt: now,
    updatedAt: now,
    lastUsedAt: undefined,
  }
}

describe('SandboxController savedImage creation contract', () => {
  it('allows non-admin users to create a box from a savedImage with resource overrides', async () => {
    const sandboxService = {
      createFromSavedImage: jest.fn().mockResolvedValue({
        id: 'box-id',
        state: SandboxState.STARTED,
      }),
    }
    const controller = new SandboxController({} as any, sandboxService as any, redisMock() as any)
    const organization = { id: 'org-id' }
    const createBoxDto = {
      name: 'saved-image-box',
      savedImageId: 'ubuntu-saved-image-id',
      cpu: 2,
      memory: 4,
      disk: 20,
    }

    await expect(
      controller.createSandbox(
        {
          organization,
          organizationId: organization.id,
          role: SystemRole.USER,
        } as any,
        createBoxDto as any,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 'box-id' }))

    expect(sandboxService.createFromSavedImage).toHaveBeenCalledWith(createBoxDto, organization)
  })

  it('maps the deprecated snapshot field to savedImageId instead of falling back to the default savedImage', async () => {
    const sandboxService = {
      createFromSavedImage: jest.fn().mockResolvedValue({
        id: 'box-id',
        state: SandboxState.STARTED,
      }),
    }
    const controller = new SandboxController({} as any, sandboxService as any, redisMock() as any)
    const organization = { id: 'org-id' }

    await expect(
      controller.createSandbox(
        {
          organization,
          organizationId: organization.id,
          role: SystemRole.USER,
        } as any,
        {
          name: 'legacy-saved-image-box',
          snapshot: 'ubuntu-saved-image-id',
        } as any,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 'box-id' }))

    expect(sandboxService.createFromSavedImage).toHaveBeenCalledWith(
      {
        name: 'legacy-saved-image-box',
        snapshot: 'ubuntu-saved-image-id',
        savedImageId: 'ubuntu-saved-image-id',
      },
      organization,
    )
  })

  it('rejects conflicting savedImageId and deprecated snapshot fields', async () => {
    const sandboxService = {
      createFromSavedImage: jest.fn(),
    }
    const controller = new SandboxController({} as any, sandboxService as any, redisMock() as any)
    const organization = { id: 'org-id' }

    await expect(
      controller.createSandbox(
        {
          organization,
          organizationId: organization.id,
          role: SystemRole.USER,
        } as any,
        {
          savedImageId: 'new-saved-image-id',
          snapshot: 'old-saved-image-id',
        } as any,
      ),
    ).rejects.toThrow('Use either savedImageId or deprecated snapshot, not both')

    expect(sandboxService.createFromSavedImage).not.toHaveBeenCalled()
  })
})
