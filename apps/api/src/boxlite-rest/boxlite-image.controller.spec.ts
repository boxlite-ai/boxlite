/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { BoxliteImageController } from './boxlite-image.controller'
import { CreateAliasDto } from './dto/create-alias.dto'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'

describe('BoxliteImageController', () => {
  const recordedAt = new Date('2026-09-01T00:00:00.000Z')
  const organization = { id: 'org-1' }
  const caller = { organization, organizationId: organization.id, userId: 'auth0|alice' } as never
  const DIGEST = `sha256:${'a'.repeat(64)}`
  const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

  // The catalog's detail, as the console's /api/images answers it.
  const catalogDetail = {
    name: 'quay.io/acme/app',
    id: 'image-1',
    curated: false,
    curatedRef: null,
    aliases: ['v1'],
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
        aliases: ['v1'],
        lastUsedAt: '2026-09-02T00:00:00.000Z',
        upstreamMissingAt: null,
        createdAt: recordedAt.toISOString(),
      },
    ],
    history: [
      {
        aliasName: 'v1',
        fromVersionId: 'version-0',
        fromDigest: OTHER_DIGEST,
        toVersionId: 'version-1',
        toDigest: DIGEST,
        actorId: 'auth0|alice',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
    ],
  }

  // The same detail in the box API's shape: versions named by digest only.
  const restDetail = {
    name: 'quay.io/acme/app',
    aliases: ['v1'],
    curated: false,
    versions: [
      {
        digest: 'sha256:aa',
        size_bytes: 4096,
        source_ref: 'quay.io/acme/app:v1',
        recorded_at: recordedAt.toISOString(),
        aliases: ['v1'],
        last_used_at: '2026-09-02T00:00:00.000Z',
        upstream_missing_at: null,
      },
    ],
    history: [
      {
        alias: 'v1',
        from_digest: OTHER_DIGEST,
        to_digest: DIGEST,
        actor: 'auth0|alice',
        recorded_at: '2026-09-03T00:00:00.000Z',
      },
    ],
  }

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
      get: jest.fn().mockResolvedValue(catalogDetail),
      createAlias: jest.fn().mockResolvedValue(catalogDetail),
      deleteAlias: jest.fn().mockResolvedValue(undefined),
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

  it('answers an image by name with its versions and its history, naming versions by digest', async () => {
    const { controller, imageCatalogService } = createController()

    await expect(controller.get(caller, 'quay.io/acme/app')).resolves.toEqual(restDetail)
    expect(imageCatalogService.get).toHaveBeenCalledWith(organization, 'quay.io/acme/app')
  })

  it('moves a tag to the version the digest names, as the caller who asked', async () => {
    const { controller, imageCatalogService } = createController()

    await expect(
      controller.createAlias(caller, 'quay.io/acme/app', { alias: 'stable', digest: DIGEST }),
    ).resolves.toEqual(restDetail)
    expect(imageCatalogService.createAlias).toHaveBeenCalledWith(
      organization,
      'quay.io/acme/app',
      'stable',
      { digest: DIGEST },
      'auth0|alice',
    )
  })

  it('takes only a sha256 digest as the version to move a tag to', async () => {
    const errorsFor = async (body: object) => validate(plainToInstance(CreateAliasDto, { alias: 'stable', ...body }))

    expect(await errorsFor({ digest: DIGEST })).toEqual([])
    for (const digest of [undefined, '', 'sha256:aa', DIGEST.toUpperCase(), `sha512:${'a'.repeat(64)}`]) {
      expect(await errorsFor({ digest })).not.toEqual([])
    }
  })

  it.each([
    ['list', OrganizationResourcePermission.READ_IMAGES],
    ['usage', OrganizationResourcePermission.READ_IMAGES],
    ['get', OrganizationResourcePermission.READ_IMAGES],
    ['createAlias', OrganizationResourcePermission.WRITE_IMAGES],
    ['deleteAlias', OrganizationResourcePermission.WRITE_IMAGES],
    ['remove', OrganizationResourcePermission.DELETE_IMAGES],
  ] as const)('requires exactly its own scope on %s', (name, scope) => {
    // The guard reads this and nothing else, so a route with the wrong scope
    // here is a route anyone holding that other scope can call.
    const route = BoxliteImageController.prototype[name]
    expect(new Reflector().get(RequiredOrganizationResourcePermissions, route)).toEqual([scope])
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
