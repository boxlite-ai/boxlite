/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { MODULE_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import { ThrottlerStorageService } from '@nestjs/throttler'
import type { Redis } from 'ioredis'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { ImageModule } from '../image/image.module'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { RegistriesService } from '../registry/services/registries.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteImageController } from './boxlite-image.controller'
import { BoxliteRegistryController } from './boxlite-registry.controller'

const credentialId = '0aaa0000-0000-4000-8000-000000000001'
const imageName = 'quay.io%2Facme%2Fapp'
const sdkOperations = [
  { method: 'GET', path: '/images' },
  { method: 'GET', path: '/images/usage' },
  { method: 'GET', path: `/images/${imageName}` },
  { method: 'DELETE', path: `/images/${imageName}` },
  {
    method: 'POST',
    path: `/images/${imageName}/aliases`,
    body: { alias: 'stable', digest: `sha256:${'a'.repeat(64)}` },
  },
  { method: 'DELETE', path: `/images/${imageName}/aliases/stable` },
  { method: 'GET', path: '/images/registries' },
  {
    method: 'POST',
    path: '/images/registries',
    body: { registry_host: 'ghcr.io', username: 'test-user', password: 'test-only-password' },
  },
  { method: 'DELETE', path: `/images/registries/${credentialId}` },
]

describe('BoxLite management rate limits', () => {
  let app: INestApplication
  let storage: ThrottlerStorageService
  let baseUrl: string
  let services: jest.Mock[]

  beforeEach(async () => {
    const detail = { name: 'quay.io/acme/app', aliases: [], curated: false, versions: [], history: [] }
    const images = {
      list: jest.fn().mockResolvedValue([]),
      listReferences: jest.fn().mockResolvedValue([]),
      usage: jest.fn().mockResolvedValue({ count: 0, limit: 20, knownBytes: 0 }),
      get: jest.fn().mockResolvedValue(detail),
      createAlias: jest.fn().mockResolvedValue(detail),
      deleteAlias: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    const registries = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: credentialId, createdAt: new Date('2026-01-01T00:00:00Z') }),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    services = [...Object.values(images), ...Object.values(registries)]
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
    const organizations = {
      findOne: jest.fn(async (id: string) => ({
        id,
        authenticatedRateLimit: 2,
        authenticatedRateLimitTtlSeconds: 60,
      })),
    }
    storage = new ThrottlerStorageService()
    const limiter = new AuthenticatedRateLimitGuard(
      [{ name: 'authenticated', ttl: 60000, limit: 10 }],
      storage,
      new Reflector(),
      redis as unknown as Redis,
      organizations as unknown as OrganizationService,
    )
    await limiter.onModuleInit()

    const moduleRef = await Test.createTestingModule({
      controllers: [
        ...Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ImageModule),
        BoxliteRegistryController,
        BoxliteImageController,
      ],
      providers: [
        { provide: ImageCatalogService, useValue: images },
        { provide: RegistriesService, useValue: registries },
        { provide: OrganizationService, useValue: organizations },
        {
          provide: OrganizationUserService,
          useValue: { findOne: jest.fn().mockResolvedValue({ role: OrganizationMemberRole.OWNER }) },
        },
        { provide: getRedisConnectionToken(), useValue: redis },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          // Authentication supplies identity only; the real organization guard
          // must attach the verified organization before throttling runs.
          request.user = {
            userId: request.headers['x-test-user'] ?? 'user-1',
            organizationId: request.headers['x-test-org'] ?? 'org-1',
            role: SystemRole.USER,
          }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue(limiter)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}/api`
  })

  afterEach(async () => {
    await app?.close()
    storage?.onApplicationShutdown()
  })

  async function request(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, options)
    await response.text()
    return response
  }

  describe.each(['', '/default', '/org-1'])('SDK prefix "%s"', (prefix) => {
    it.each(sdkOperations)('rejects $method $path after the console exhausts the organization quota', async (op) => {
      expect((await request('/images/registries', { headers: { 'x-test-user': 'user-1' } })).status).toBe(200)
      expect((await request('/images', { headers: { 'x-test-user': 'user-2' } })).status).toBe(200)
      services.forEach((service) => service.mockClear())

      const response = await request(`/v1${prefix}${op.path}`, {
        method: op.method,
        headers: { 'content-type': 'application/json', 'x-test-user': 'user-3' },
        body: op.body ? JSON.stringify(op.body) : undefined,
      })

      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after-authenticated'))).toBeGreaterThan(0)
      services.forEach((service) => expect(service).not.toHaveBeenCalled())
    })
  })

  it('shares the SDK quota with console requests while keeping organizations independent', async () => {
    expect((await request('/v1/images')).status).toBe(200)
    expect((await request('/v1/default/images/registries', { headers: { 'x-test-user': 'user-2' } })).status).toBe(200)

    expect((await request('/images/registries', { headers: { 'x-test-user': 'user-3' } })).status).toBe(429)
    expect((await request('/v1/images', { headers: { 'x-test-org': 'org-2' } })).status).toBe(200)
  })

  it('routes nested registries before the image name parameter', async () => {
    const response = await fetch(`${baseUrl}/images/registries`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect((await request('/registries')).status).toBe(404)
  })
})
