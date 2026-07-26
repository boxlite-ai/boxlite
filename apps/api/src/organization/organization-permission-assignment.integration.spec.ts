/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type CanActivate, type ExecutionContext, ValidationPipe } from '@nestjs/common'
import { SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { AddressInfo } from 'node:net'
import { ApiKeyController } from '../api-key/api-key.controller'
import { ApiKeyService } from '../api-key/api-key.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { SystemRole } from '../user/enums/system-role.enum'
import { OrganizationRoleController } from './controllers/organization-role.controller'
import { OrganizationActionGuard } from './guards/organization-action.guard'
import { OrganizationResourceActionGuard } from './guards/organization-resource-action.guard'
import { OrganizationRoleService } from './services/organization-role.service'

const supportedPermissions = ['write:boxes', 'delete:boxes']

const unsupportedPermissions = [
  'write:registries',
  'delete:registries',
  'write:templates',
  'delete:templates',
  'write:regions',
  'delete:regions',
  'read:runners',
  'write:runners',
  'delete:runners',
  'read:volumes',
  'write:volumes',
  'delete:volumes',
  'read:audit_logs',
]

describe('Organization permission assignment integration', () => {
  let app: INestApplication
  let baseUrl: string
  const apiKeyService = {
    createApiKey: jest.fn(),
  }
  const organizationRoleService = {
    create: jest.fn(),
    update: jest.fn(),
  }

  beforeAll(async () => {
    const injectAdmin: CanActivate = {
      canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest().user = {
          organizationId: 'org-1',
          userId: 'admin-1',
          role: SystemRole.ADMIN,
        }
        return true
      },
    }
    const allow: CanActivate = { canActivate: () => true }
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiKeyController, OrganizationRoleController],
      providers: [
        { provide: ApiKeyService, useValue: apiKeyService },
        { provide: OrganizationRoleService, useValue: organizationRoleService },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue(injectAdmin)
      .overrideGuard(AuthGuard('jwt'))
      .useValue(injectAdmin)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue(allow)
      .overrideGuard(OrganizationActionGuard)
      .useValue(allow)
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue(allow)
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
    const address = app.getHttpServer().address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.createApiKey.mockImplementation(async (_organizationId, _userId, name, permissions, expiresAt) => ({
      apiKey: {
        name,
        permissions,
        expiresAt,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      value: 'boxlite_test_key',
    }))
    organizationRoleService.create.mockImplementation(async (organizationId, role) => ({
      ...role,
      id: 'role-1',
      organizationId,
      isGlobal: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }))
    organizationRoleService.update.mockImplementation(async (roleId, role) => ({
      ...role,
      id: roleId,
      organizationId: 'org-1',
      isGlobal: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }))
  })

  afterAll(async () => {
    await app.close()
  })

  async function post(path: string, body: object): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function put(path: string, body: object): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it.each(unsupportedPermissions)(
    'rejects unsupported API-key permission %s at the HTTP boundary',
    async (permission) => {
      const response = await post('/api-keys', { name: 'automation', permissions: [permission] })

      expect(response.status).toBe(400)
      expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
    },
  )

  it.each(unsupportedPermissions)('rejects unsupported role permission %s at the HTTP boundary', async (permission) => {
    const response = await post('/organizations/org-1/roles', {
      name: 'Maintainer',
      description: 'Maintains supported resources',
      permissions: [permission],
    })

    expect(response.status).toBe(400)
    expect(organizationRoleService.create).not.toHaveBeenCalled()
  })

  it.each(unsupportedPermissions)(
    'rejects unsupported role update permission %s at the HTTP boundary',
    async (permission) => {
      const response = await put('/organizations/org-1/roles/role-1', {
        name: 'Maintainer',
        description: 'Maintains supported resources',
        permissions: [permission],
      })

      expect(response.status).toBe(400)
      expect(organizationRoleService.update).not.toHaveBeenCalled()
    },
  )

  it('allows every supported permission through all assignment endpoints', async () => {
    const apiKeyResponse = await post('/api-keys', { name: 'automation', permissions: supportedPermissions })
    const roleResponse = await post('/organizations/org-1/roles', {
      name: 'Maintainer',
      description: 'Maintains supported resources',
      permissions: supportedPermissions,
    })
    const roleUpdateResponse = await put('/organizations/org-1/roles/role-1', {
      name: 'Maintainer',
      description: 'Maintains supported resources',
      permissions: supportedPermissions,
    })

    expect(apiKeyResponse.status).toBe(201)
    expect(roleResponse.status).toBe(201)
    expect(roleUpdateResponse.status).toBe(200)
    expect(apiKeyService.createApiKey).toHaveBeenCalledTimes(1)
    expect(organizationRoleService.create).toHaveBeenCalledTimes(1)
    expect(organizationRoleService.update).toHaveBeenCalledTimes(1)
  })

  it.each(['CreateApiKey', 'CreateOrganizationRole', 'UpdateOrganizationRole'])(
    'documents only supported values in the %s request schema',
    (schemaName) => {
      const document = SwaggerModule.createDocument(app, {
        openapi: '3.0.0',
        info: { title: 'permission assignment test', version: '1' },
      })
      const schema = document.components?.schemas?.[schemaName] as
        | { properties?: { permissions?: { items?: { enum?: string[] } } } }
        | undefined

      expect(schema?.properties?.permissions?.items?.enum).toEqual(supportedPermissions)
    },
  )
})
