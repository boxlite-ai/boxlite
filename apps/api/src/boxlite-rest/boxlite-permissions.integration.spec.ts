/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { Test } from '@nestjs/testing'
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { RunnerService } from '../box/services/runner.service'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

const KEY_PERMISSIONS: Record<string, OrganizationResourcePermission[]> = {
  read: [],
  'admin-read': [],
  write: [OrganizationResourcePermission.WRITE_BOXES],
  delete: [OrganizationResourcePermission.DELETE_BOXES],
}

describe('BoxLite REST permission integration', () => {
  let app: INestApplication
  const organization = { id: 'org-1' }
  const boxService = {
    create: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    findAllDeprecated: jest.fn().mockResolvedValue([]),
    toBoxDtos: jest.fn().mockResolvedValue([]),
    getNetworkTunnelUrl: jest.fn().mockResolvedValue('http://127.0.0.1/tunnel'),
  }

  const authenticationGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest()
      const authorization = request.headers.authorization as string | undefined
      const token = authorization?.replace(/^Bearer\s+/i, '')
      const permissions = token ? KEY_PERMISSIONS[token] : undefined
      if (!permissions) {
        return false
      }

      request.user = {
        organizationId: organization.id,
        userId: 'owner-1',
        email: 'owner@example.com',
        role: token === 'admin-read' ? SystemRole.ADMIN : SystemRole.USER,
        apiKey: {
          organizationId: organization.id,
          userId: 'owner-1',
          name: `${token}-key`,
          permissions,
        },
      }
      return true
    },
  }

  beforeAll(async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteBoxController, BoxliteProxyController],
      providers: [
        OrganizationResourceActionGuard,
        {
          provide: getRedisConnectionToken(),
          useValue: redis,
        },
        {
          provide: OrganizationService,
          useValue: {
            findOne: jest.fn().mockResolvedValue(organization),
          },
        },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              organizationId: organization.id,
              userId: 'owner-1',
              role: OrganizationMemberRole.OWNER,
              assignedRoles: [],
            }),
          },
        },
        {
          provide: BoxService,
          useValue: boxService,
        },
        {
          provide: BoxStateWaiterService,
          useValue: {},
        },
        {
          provide: RunnerService,
          useValue: {},
        },
        {
          provide: BoxAutoResumeService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue(authenticationGuard)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  async function request(path: string, credential: keyof typeof KEY_PERMISSIONS, init?: RequestInit): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
  }

  it('allows an owner API key without mutation permissions to list boxes', async () => {
    const response = await request('/api/v1/boxes', 'read')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ boxes: [] })
    expect(boxService.findAllDeprecated).toHaveBeenCalledWith(organization.id)
  })

  it('rejects create before invoking BoxService when an owner API key lacks Box write permission', async () => {
    const response = await request('/api/v1/boxes', 'read', {
      method: 'POST',
      body: JSON.stringify({ image: 'ubuntu:24.04' }),
    })

    expect(response.status).toBe(403)
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('rejects create when a system administrator API key lacks Box write permission', async () => {
    const response = await request('/api/v1/boxes', 'admin-read', {
      method: 'POST',
      body: JSON.stringify({ image: 'ubuntu:24.04' }),
    })

    expect(response.status).toBe(403)
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('allows a Box write API key to create a network tunnel', async () => {
    const response = await request('/api/v1/boxes/box-1/network/tunnel?port=3000', 'write', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ uri: 'http://127.0.0.1/tunnel' })
    expect(boxService.getNetworkTunnelUrl).toHaveBeenCalledWith('box-1', organization.id, 3000)
  })

  it('does not let Box write permission authorize box destruction', async () => {
    const response = await request('/api/v1/boxes/box-1', 'write', {
      method: 'DELETE',
    })

    expect(response.status).toBe(403)
    expect(boxService.destroy).not.toHaveBeenCalled()
  })

  it('allows a Box delete API key to destroy a box', async () => {
    const response = await request('/api/v1/boxes/box-1', 'delete', {
      method: 'DELETE',
    })

    expect(response.status).toBe(204)
    expect(boxService.destroy).toHaveBeenCalledWith('box-1', organization.id)
  })
})
