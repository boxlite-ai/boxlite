/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { BoxliteImageController } from './boxlite-image.controller'
import { ImageCatalogService } from '../image/services/image-catalog.service'

describe('BoxliteImageController', () => {
  const recordedAt = new Date('2026-09-01T00:00:00.000Z')
  const organization = { id: 'org-1' }
  const caller = { organization, organizationId: organization.id } as never

  function createController() {
    const imageCatalogService = {
      listReferences: jest.fn().mockResolvedValue([
        {
          reference: 'quay.io/acme/app:v1',
          name: 'quay.io/acme/app',
          tag: 'v1',
          digest: 'sha256:aa',
          sizeBytes: 4096,
          recordedAt,
        },
      ]),
      usage: jest.fn().mockResolvedValue({ count: 3, limit: 20, knownBytes: 8192 }),
      get: jest.fn().mockResolvedValue({
        name: 'quay.io/acme/app',
        id: 'image-1',
        curated: false,
        curatedRef: null,
        tags: ['v1'],
        versionCount: 1,
        sizeBytes: 4096,
        lastUsedAt: null,
        createdAt: recordedAt.toISOString(),
        versions: [
          {
            id: 'version-1',
            digest: 'sha256:aa',
            sizeBytes: 4096,
            sourceRef: 'quay.io/acme/app:v1',
            createdAt: recordedAt.toISOString(),
          },
        ],
        history: [],
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    return {
      controller: new BoxliteImageController(imageCatalogService as unknown as ImageCatalogService),
      imageCatalogService,
    }
  }

  it('is mounted with and without a routing prefix, like the other box API routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteImageController)).toEqual(['v1/images', 'v1/:prefix/images'])
  })

  it('lists one row per reference in the box API shape', async () => {
    const { controller, imageCatalogService } = createController()

    await expect(controller.list(caller)).resolves.toEqual({
      images: [
        {
          reference: 'quay.io/acme/app:v1',
          repository: 'quay.io/acme/app',
          tag: 'v1',
          id: 'sha256:aa',
          cached_at: recordedAt.toISOString(),
          size_bytes: 4096,
        },
      ],
    })
    expect(imageCatalogService.listReferences).toHaveBeenCalledWith(organization)
  })

  it('answers an image by name with its versions', async () => {
    const { controller, imageCatalogService } = createController()

    await expect(controller.get(caller, 'quay.io/acme/app')).resolves.toEqual({
      name: 'quay.io/acme/app',
      tags: ['v1'],
      curated: false,
      versions: [
        {
          digest: 'sha256:aa',
          size_bytes: 4096,
          source_ref: 'quay.io/acme/app:v1',
          recorded_at: recordedAt.toISOString(),
        },
      ],
    })
    expect(imageCatalogService.get).toHaveBeenCalledWith(organization, 'quay.io/acme/app')
  })

  it('answers usage as count, limit and known bytes', async () => {
    const { controller } = createController()

    await expect(controller.usage(caller)).resolves.toEqual({ count: 3, limit: 20, known_bytes: 8192 })
  })

  it('removes the catalog entry, and lets the in-use refusal through as a 409', async () => {
    const { controller, imageCatalogService } = createController()

    await expect(controller.remove(caller, 'quay.io/acme/app')).resolves.toBeUndefined()
    expect(imageCatalogService.delete).toHaveBeenCalledWith(organization, 'quay.io/acme/app')

    imageCatalogService.delete.mockRejectedValueOnce(new ConflictException('in use by box b1'))
    await expect(controller.remove(caller, 'quay.io/acme/app')).rejects.toBeInstanceOf(ConflictException)
  })
})
