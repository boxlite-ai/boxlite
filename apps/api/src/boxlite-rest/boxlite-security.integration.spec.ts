/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { ThrottlerStorageService, type ThrottlerModuleOptions } from '@nestjs/throttler'
import type { Redis } from 'ioredis'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteRequestThrottleService } from './boxlite-request-throttle.service'

describe('BoxLite v1 security integration', () => {
  let app: NestExpressApplication
  let storage: ThrottlerStorageService
  let upgradeThrottle: BoxliteRequestThrottleService

  const authContext: AuthContext = {
    userId: 'user-1',
    email: 'svc@example.com',
    role: 'user' as AuthContext['role'],
    organizationId: 'org-1',
    apiKey: {
      organizationId: 'org-1',
      userId: 'user-1',
      permissions: [OrganizationResourcePermission.WRITE_BOXES],
    } as AuthContext['apiKey'],
  }

  beforeEach(async () => {
    const options: ThrottlerModuleOptions = {
      throttlers: [
        { name: 'anonymous', limit: 1, ttl: 60_000 },
        { name: 'authenticated', limit: 1, ttl: 60_000 },
      ],
    }
    storage = new ThrottlerStorageService()
    const reflector = new Reflector()
    const organizationService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'org-1',
        authenticatedRateLimit: null,
        authenticatedRateLimitTtlSeconds: null,
      }),
      findByUserWithDefaultFlag: jest.fn().mockResolvedValue([
        {
          isDefaultForAuthenticatedUser: true,
          organization: { id: 'org-1' },
          organizationUser: {
            role: OrganizationMemberRole.MEMBER,
            assignedRoles: [{ permissions: [OrganizationResourcePermission.WRITE_BOXES] }],
          },
        },
      ]),
    }
    const organizationUserService = {
      findOne: jest.fn().mockResolvedValue({
        role: OrganizationMemberRole.MEMBER,
        assignedRoles: [],
      }),
      getAssignedPermissions: jest.fn().mockReturnValue(new Set([OrganizationResourcePermission.WRITE_BOXES])),
    }
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    } as unknown as Redis

    const anonymousGuard = new AnonymousRateLimitGuard(options, storage, reflector)
    const authenticatedGuard = new AuthenticatedRateLimitGuard(
      options,
      storage,
      reflector,
      redis,
      organizationService as unknown as OrganizationService,
    )
    await anonymousGuard.onModuleInit()
    await authenticatedGuard.onModuleInit()

    const injectAuthentication: CanActivate = {
      canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest()
        if (request.headers.authorization === 'Bearer test') {
          request.user = {
            userId: authContext.userId,
            email: authContext.email,
            role: authContext.role,
            organizationId: request.headers['x-boxlite-organization-id'],
          }
        } else {
          request.user = authContext
        }
        return true
      },
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteConfigController, BoxliteMeController],
      providers: [
        {
          provide: OrganizationService,
          useValue: organizationService,
        },
        {
          provide: OrganizationUserService,
          useValue: organizationUserService,
        },
      ],
    })
      .overrideGuard(AnonymousRateLimitGuard)
      .useValue(anonymousGuard)
      .overrideGuard(CombinedAuthGuard)
      .useValue(injectAuthentication)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue(authenticatedGuard)
      .compile()

    app = moduleRef.createNestApplication<NestExpressApplication>()
    app.setGlobalPrefix('api')
    app.set('trust proxy', true)
    upgradeThrottle = new BoxliteRequestThrottleService(options, storage, organizationService as never)
    await app.listen(0)
  })

  afterEach(async () => {
    await app.close()
    storage.onApplicationShutdown()
  })

  async function request(path: string, headers?: Record<string, string>): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, { headers })
  }

  it('does not let HTTP clients rotate anonymous quota keys with forwarded headers', async () => {
    const first = await request('/api/v1/config', {
      'x-forwarded-for': '203.0.113.8, 198.51.100.24',
    })
    const second = await request('/api/v1/config', {
      'x-forwarded-for': '192.0.2.9, 198.51.100.24',
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after-anonymous')).toBe('60')
  })

  it('shares the anonymous quota between HTTP and websocket upgrades', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.8, 198.51.100.24' }
    const response = await request('/api/v1/config', headers)

    expect(response.status).toBe(200)
    await expect(
      upgradeThrottle.consumeAnonymous({
        headers,
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as import('http').IncomingMessage),
    ).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    })
  })

  it('returns effective scopes and enforces the shared authenticated organization quota', async () => {
    const first = await request('/api/v1/me')
    const second = await request('/api/v1/me')

    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual(
      expect.objectContaining({
        scopes: ['box:read', 'box:write', 'box:exec', 'me:read'],
      }),
    )
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after-authenticated')).toBe('60')
  })

  it('does not key interactive /v1/me throttling from an unvalidated organization header', async () => {
    const first = await request('/api/v1/me', {
      authorization: 'Bearer test',
      'x-boxlite-organization-id': 'attacker-org-1',
    })
    const second = await request('/api/v1/me', {
      authorization: 'Bearer test',
      'x-boxlite-organization-id': 'attacker-org-2',
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after-authenticated')).toBe('60')
  })
})
