/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { INestApplication } from '@nestjs/common'
import { ConflictException, ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { AuditInterceptor } from '../../audit/interceptors/audit.interceptor'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { ImageCatalogService } from '../services/image-catalog.service'
import { ImageController } from './image.controller'

const ORGANIZATION = { id: 'org-123', imageCountLimit: 20 }
const USER_ID = 'auth0|6512bd43d9caa6e02c990b0a'
const VERSION_ID = '123e4567-e89b-12d3-a456-426614174000'

describe('ImageController routing', () => {
  let app: INestApplication
  let catalog: {
    list: jest.Mock
    get: jest.Mock
    createAlias: jest.Mock
    deleteAlias: jest.Mock
    delete: jest.Mock
    usage: jest.Mock
  }
  let audit: { createLog: jest.Mock; updateLog: jest.Mock }

  beforeEach(async () => {
    audit = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      updateLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    catalog = {
      list: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue({ name: 'quay.io/acme/app' }),
      createAlias: jest.fn().mockResolvedValue({ name: 'quay.io/acme/app' }),
      deleteAlias: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      usage: jest.fn().mockResolvedValue({ count: 1, limit: 20, knownBytes: 42 }),
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [ImageController],
      providers: [{ provide: ImageCatalogService, useValue: catalog }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = {
            userId: USER_ID,
            email: 'user@example.test',
            organizationId: ORGANIZATION.id,
            organization: ORGANIZATION,
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    // Global in main.ts too, so each route's @Audit metadata is read the way
    // production reads it.
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), audit as never, { get: jest.fn() } as never))
    // As `main.ts` installs it, so a body the DTO refuses is refused here too.
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
  })

  afterEach(async () => {
    await app?.close()
  })

  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
  }

  /**
   * `usage` and `:idOrRef` are both one path segment, and Nest matches in
   * declaration order — so a `:idOrRef` declared first would answer this with
   * "image 'usage' not found". Asserted through a real router rather than by
   * reading the decorators, because declaration order is the thing under test.
   */
  it('answers /images/usage with usage rather than treating it as an image name', async () => {
    const response = await request('GET', '/api/images/usage')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ count: 1, limit: 20, knownBytes: 42 })
    expect(catalog.usage).toHaveBeenCalledWith(ORGANIZATION)
    expect(catalog.get).not.toHaveBeenCalled()
  })

  it('accepts a catalog id as :idOrRef', async () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'

    const response = await request('GET', `/api/images/${id}`)

    expect(response.status).toBe(200)
    expect(catalog.get).toHaveBeenCalledWith(ORGANIZATION, id)
  })

  /**
   * A reference carries slashes, so it reaches the route percent-encoded. What
   * matters is that the encoding survives routing and arrives decoded: the
   * catalog looks rows up by the reference a caller would type.
   */
  it('accepts a URL-encoded reference as :idOrRef', async () => {
    const response = await request('GET', '/api/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(200)
    expect(catalog.get).toHaveBeenCalledWith(ORGANIZATION, 'quay.io/acme/app')
  })

  it('returns 204 with no body when an image is removed', async () => {
    const response = await request('DELETE', '/api/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(catalog.delete).toHaveBeenCalledWith(ORGANIZATION, 'quay.io/acme/app')
  })

  /**
   * The audit target is the image the caller named, decoded by the router —
   * not the percent-encoded segment, which nobody searching the log would type.
   */
  it('audits a removal against the reference the caller named', async () => {
    const response = await request('DELETE', '/api/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(204)
    expect(audit.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.DELETE,
        targetType: AuditTarget.IMAGE,
        targetId: 'quay.io/acme/app',
        organizationId: ORGANIZATION.id,
      }),
    )
  })

  /**
   * The status is the contract: a box still holding the image is a conflict,
   * not a malformed request. A 400 here would tell a caller to fix its input,
   * when what it has to do is destroy a box or leave the image alone.
   */
  it('surfaces an in-use refusal as 409', async () => {
    catalog.delete.mockRejectedValue(new ConflictException('still in use by box-1'))

    const response = await request('DELETE', '/api/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(409)
  })

  it('lists images', async () => {
    const response = await request('GET', '/api/images')

    expect(response.status).toBe(200)
    expect(catalog.list).toHaveBeenCalledWith(ORGANIZATION)
  })

  it('creates an alias on an encoded image name', async () => {
    const response = await request('POST', '/api/images/quay.io%2Facme%2Fapp/aliases', {
      alias: 'stable',
      versionId: VERSION_ID,
    })
    expect(response.status).toBe(201)
    expect(catalog.createAlias).toHaveBeenCalledWith(
      ORGANIZATION,
      'quay.io/acme/app',
      'stable',
      { versionId: VERSION_ID },
      USER_ID,
    )
  })

  it.each([{}, { alias: '-bad', versionId: VERSION_ID }, { alias: 'stable', versionId: 'v2' }])(
    'refuses invalid alias creation %j before reaching the catalog',
    async (body) => {
      expect((await request('POST', '/api/images/quay.io%2Facme%2Fapp/aliases', body)).status).toBe(400)
      expect(catalog.createAlias).not.toHaveBeenCalled()
    },
  )

  it('surfaces an existing alias as a conflict', async () => {
    catalog.createAlias.mockRejectedValue(new ConflictException({ message: 'alias exists', code: 'already_exists' }))
    expect(
      (await request('POST', '/api/images/quay.io%2Facme%2Fapp/aliases', { alias: 'stable', versionId: VERSION_ID }))
        .status,
    ).toBe(409)
  })

  it('deletes an alias explicitly', async () => {
    expect((await request('DELETE', '/api/images/quay.io%2Facme%2Fapp/aliases/stable')).status).toBe(204)
    expect(catalog.deleteAlias).toHaveBeenCalledWith(ORGANIZATION, 'quay.io/acme/app', 'stable')
  })

  it('does not expose tag or alias replacement routes', async () => {
    for (const selector of ['tags', 'aliases']) {
      expect(
        (await request('PUT', `/api/images/quay.io%2Facme%2Fapp/${selector}/stable`, { versionId: VERSION_ID })).status,
      ).toBe(404)
    }
  })
})

describe('ImageController permissions', () => {
  const reflector = new Reflector()
  const route = (name: keyof ImageController) => ImageController.prototype[name]

  it.each([
    ['listImages', OrganizationResourcePermission.READ_IMAGES],
    ['getImageUsage', OrganizationResourcePermission.READ_IMAGES],
    ['getImage', OrganizationResourcePermission.READ_IMAGES],
    ['createImageAlias', OrganizationResourcePermission.WRITE_IMAGES],
    ['deleteImageAlias', OrganizationResourcePermission.WRITE_IMAGES],
    ['deleteImage', OrganizationResourcePermission.DELETE_IMAGES],
  ] as const)('requires exactly its own scope on %s', (name, scope) => {
    // The guard reads this and nothing else, so a route with the wrong scope
    // here is a route anyone holding that other scope can call.
    expect(reflector.get(RequiredOrganizationResourcePermissions, route(name))).toEqual([scope])
  })
})
