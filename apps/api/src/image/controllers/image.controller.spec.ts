/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { INestApplication } from '@nestjs/common'
import { ConflictException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { AuditInterceptor } from '../../audit/interceptors/audit.interceptor'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { ImageCatalogService } from '../services/image-catalog.service'
import { ImageController } from './image.controller'

const ORGANIZATION = { id: 'org-123', imageCountLimit: 20 }

describe('ImageController routing', () => {
  let app: INestApplication
  let catalog: {
    list: jest.Mock
    get: jest.Mock
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
            userId: 'user-1',
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
    await app.listen(0)
  })

  afterEach(async () => {
    await app?.close()
  })

  const request = async (method: string, path: string): Promise<Response> => {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, { method })
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
})
