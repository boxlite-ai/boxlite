/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageRegion } from '../entities/saved-image-region.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { SavedImageEvents } from '../constants/saved-image-events'
import { SavedImageService } from './saved-image.service'
import { SandboxState } from '../enums/sandbox-state.enum'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function createService({
  savedImages = [],
  availableRegionIds = ['us'],
  defaultSavedImage = 'ubuntu:24.04',
}: {
  savedImages?: SavedImage[]
  availableRegionIds?: string[]
  defaultSavedImage?: string
}) {
  const savedImageRepository = {
    find: jest.fn(async (options?: { where?: Partial<SavedImage> }) => {
      const where = options?.where
      if (!where) return savedImages

      return savedImages.filter((savedImage) =>
        Object.entries(where).every(([key, value]) => savedImage[key as keyof SavedImage] === value),
      )
    }),
    findOne: jest.fn(),
    save: jest.fn(async (savedImage: SavedImage) => savedImage),
  }
  const savedImageRegionRepository = {
    save: jest.fn(async (savedImageRegion) => savedImageRegion),
  }
  const sandboxRepository = {
    findOne: jest.fn(),
  }
  const organizationService = {
    listAvailableRegions: jest.fn().mockResolvedValue(availableRegionIds.map((id) => ({ id }))),
  }
  const configService = {
    get: jest.fn((key: string) => (key === 'defaultSavedImage' ? defaultSavedImage : undefined)),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'defaultRegion.id') return 'us'
      if (key === 'defaultSavedImage') return defaultSavedImage
      throw new Error(`Unexpected config key: ${key}`)
    }),
  }
  const eventEmitter = {
    emit: jest.fn(),
  }
  const dockerRegistryService = {
    getAvailableInternalRegistry: jest.fn(async () => ({
      url: 'http://current-registry.local',
      project: 'boxlite',
    })),
  }

  const service = new SavedImageService(
    sandboxRepository as any,
    savedImageRepository as any,
    {} as any,
    {} as any,
    {} as any,
    savedImageRegionRepository as any,
    organizationService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    dockerRegistryService as any,
    eventEmitter as any,
    configService as any,
  )

  return {
    service,
    sandboxRepository,
    savedImageRepository,
    savedImageRegionRepository,
    organizationService,
    eventEmitter,
    dockerRegistryService,
  }
}

function savedImage(partial: Partial<SavedImage>): SavedImage {
  const id = partial.id ?? 'saved-image-id'

  return {
    id,
    name: partial.name ?? 'ubuntu:24.04',
    imageName: partial.imageName ?? partial.name ?? 'ubuntu:24.04',
    general: partial.general ?? true,
    hideFromUsers: partial.hideFromUsers ?? false,
    state: partial.state ?? SavedImageState.ACTIVE,
    cpu: partial.cpu ?? 1,
    gpu: partial.gpu ?? 0,
    mem: partial.mem ?? 1,
    disk: partial.disk ?? 3,
    artifactRef: partial.artifactRef ?? partial.imageName ?? partial.name ?? 'ubuntu:24.04',
    savedImageRegions: partial.savedImageRegions ?? [savedImageRegion(id, 'us')],
  } as SavedImage
}

function savedImageRegion(savedImageId: string, regionId: string): SavedImageRegion {
  return { savedImageId, regionId } as SavedImageRegion
}

describe('SavedImageService system savedImages', () => {
  it('returns only visible active MVP savedImages that are available to the organization', async () => {
    const ubuntu = savedImage({ id: 'ubuntu-id', name: 'ubuntu:24.04' })
    const alpine = savedImage({
      id: 'alpine-id',
      name: 'alpine:3.23',
      savedImageRegions: [savedImageRegion('alpine-id', 'eu')],
    })
    const node = savedImage({ id: 'node-id', name: 'node:22', imageName: 'node:22' })
    const hiddenDebian = savedImage({ id: 'debian-id', name: 'debian:13-slim', hideFromUsers: true })
    const unusableDebian = savedImage({ id: 'unusable-debian-id', name: 'debian:13-slim', artifactRef: '' })

    const { service, savedImageRepository, organizationService } = createService({
      savedImages: [alpine, node, hiddenDebian, unusableDebian, ubuntu],
      availableRegionIds: ['us'],
    })

    const savedImages = await service.getSystemSavedImages('org-id')

    expect(savedImageRepository.find).toHaveBeenCalledWith({
      where: {
        general: true,
        hideFromUsers: false,
        state: SavedImageState.ACTIVE,
      },
      relations: ['savedImageRegions'],
      order: {
        name: 'ASC',
      },
    })
    expect(organizationService.listAvailableRegions).toHaveBeenCalledWith('org-id')
    expect(savedImages.map((savedImage) => savedImage.name)).toEqual(['ubuntu:24.04'])
  })

  it('sorts available savedImages by configured default first, then MVP order', async () => {
    const { service } = createService({
      savedImages: [
        savedImage({ id: 'alpine-id', name: 'alpine:3.23' }),
        savedImage({ id: 'debian-id', name: 'debian:13-slim' }),
        savedImage({ id: 'ubuntu-id', name: 'ubuntu:24.04' }),
      ],
      defaultSavedImage: 'debian:13-slim',
    })

    const savedImages = await service.getSystemSavedImages('org-id')

    expect(savedImages.map((savedImage) => savedImage.name)).toEqual(['debian:13-slim', 'ubuntu:24.04', 'alpine:3.23'])
  })

  it('repairs an existing hidden system savedImage and attaches the default region', async () => {
    const existingSavedImage = savedImage({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      imageName: 'old/ubuntu:24.04',
      hideFromUsers: true,
      savedImageRegions: [],
    })

    const { service, savedImageRepository, savedImageRegionRepository } = createService({})
    savedImageRepository.findOne.mockResolvedValue(existingSavedImage)

    await service.ensureSystemSavedImage({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
    })

    expect(savedImageRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        imageName: 'ubuntu:24.04',
        hideFromUsers: false,
      }),
    )
    expect(savedImageRegionRepository.save).toHaveBeenCalledWith({
      savedImageId: 'ubuntu-id',
      regionId: 'us',
    })
  })

  it('creates missing system savedImages as general savedImages', async () => {
    const { service, savedImageRepository } = createService({})
    const createdSavedImage = savedImage({ id: 'debian-id', name: 'debian:13-slim' })
    savedImageRepository.findOne.mockResolvedValue(null)
    const createFromPull = jest.spyOn(service, 'createFromPull').mockResolvedValue(createdSavedImage)

    await service.ensureSystemSavedImage({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'debian:13-slim',
      imageName: 'debian:13-slim',
      displayName: 'Debian 13 slim',
      description: 'Small Debian-based savedImage',
    })

    expect(createFromPull).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-org-id' }),
      {
        name: 'debian:13-slim',
        imageName: 'debian:13-slim',
      },
      true,
    )
  })

  it('reactivates failed system savedImages during startup repair', async () => {
    const existingSavedImage = savedImage({
      id: 'alpine-id',
      name: 'alpine:3.23',
      state: SavedImageState.ERROR,
      errorReason: 'Previous pull failed',
      savedImageRegions: [savedImageRegion('alpine-id', 'us')],
    })

    const { service, savedImageRepository, eventEmitter } = createService({})
    savedImageRepository.findOne.mockResolvedValue(existingSavedImage)

    await service.ensureSystemSavedImage({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'alpine:3.23',
      imageName: 'alpine:3.23',
      displayName: 'Alpine 3.23',
      description: 'Minimal Linux savedImage',
    })

    expect(savedImageRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: SavedImageState.PENDING,
        errorReason: undefined,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(SavedImageEvents.ACTIVATED, expect.any(Object))
  })

  it('reactivates active system savedImages that are missing a usable artifact ref', async () => {
    const existingSavedImage = savedImage({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      state: SavedImageState.ACTIVE,
      artifactRef: '',
      savedImageRegions: [savedImageRegion('ubuntu-id', 'us')],
    })

    const { service, savedImageRepository, eventEmitter } = createService({})
    savedImageRepository.findOne.mockResolvedValue(existingSavedImage)

    await service.ensureSystemSavedImage({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
    })

    expect(savedImageRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: SavedImageState.PENDING,
        errorReason: undefined,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(SavedImageEvents.ACTIVATED, expect.any(Object))
  })

  it('reactivates active system savedImages pinned to a previous internal registry host', async () => {
    const existingSavedImage = savedImage({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      state: SavedImageState.ACTIVE,
      artifactRef: `old-registry.local/boxlite/boxlite-${'a'.repeat(64)}:boxlite`,
      initialRunnerId: 'old-runner-id',
      size: 1,
      savedImageRegions: [savedImageRegion('ubuntu-id', 'us')],
    })

    const { service, savedImageRepository, eventEmitter } = createService({})
    savedImageRepository.findOne.mockResolvedValue(existingSavedImage)

    await service.ensureSystemSavedImage({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
    })

    expect(savedImageRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: SavedImageState.PENDING,
        artifactRef: null,
        initialRunnerId: null,
        size: null,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(SavedImageEvents.ACTIVATED, expect.any(Object))
  })

  it('keeps backup snapshot references distinct when checking image cleanup', async () => {
    const imageName = 'registry.local/boxlite/backup-box:123'
    const { service, savedImageRepository, sandboxRepository } = createService({})
    savedImageRepository.findOne.mockResolvedValue(null)
    sandboxRepository.findOne.mockResolvedValue({ state: SandboxState.STOPPED })

    const canCleanup = await service.canCleanupImage(imageName)

    expect(canCleanup).toBe(false)
    const where = sandboxRepository.findOne.mock.calls[0][0].where
    const backupSnapshotQuery = where[0].existingBackupSnapshots as { _getSql: (alias: string) => string }
    expect(backupSnapshotQuery._getSql('existingBackupSnapshots')).toContain('"snapshotName"')
    expect(backupSnapshotQuery._getSql('existingBackupSnapshots')).not.toContain('"savedImageName"')
  })
})
