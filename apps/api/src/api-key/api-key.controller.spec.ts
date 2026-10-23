/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { ApiKeyController } from './api-key.controller'
import { ApiKeyService } from './api-key.service'

describe('API key authorization', () => {
  let app: INestApplication
  let principal: Record<string, unknown>
  let membership: { role: OrganizationMemberRole; assignedRoles: { permissions: Permission[] }[] }
  const createApiKey = jest.fn(async (_org: string, _user: string, name: string, permissions: Permission[]) => ({
    apiKey: { name, permissions, createdAt: new Date(), keyPrefix: 'blk_test', keySuffix: '123' },
    value: 'test-key',
  }))
  const deleteApiKey = jest.fn(async () => undefined)

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiKeyController],
      providers: [
        OrganizationResourceActionGuard,
        { provide: ApiKeyService, useValue: { createApiKey, deleteApiKey } },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: { findOne: async (organizationId: string) => (organizationId === 'org-1' ? membership : null) },
        },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { ...principal }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
  })

  afterAll(async () => app?.close())

  beforeEach(() => {
    jest.clearAllMocks()
    membership = { role: OrganizationMemberRole.OWNER, assignedRoles: [] }
    principal = {
      userId: 'owner-1',
      organizationId: 'org-1',
      role: SystemRole.USER,
      apiKey: { organizationId: 'org-1', name: 'calling-key', permissions: [Permission.WRITE_BOXES] },
    }
  })

  async function create(permissions: Permission[]) {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'delegated-key', permissions }),
    })
  }

  it.each([SystemRole.USER, SystemRole.ADMIN])(
    'refuses scope expansion by a %s key before persistence',
    async (role) => {
      principal.role = role

      expect((await create([Permission.DELETE_BOXES])).status).toBe(403)
      expect(createApiKey).not.toHaveBeenCalled()
    },
  )

  it('refuses expansion by an empty key', async () => {
    principal.apiKey = { organizationId: 'org-1', permissions: [] }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it('refuses expansion by a legacy key with no permissions array', async () => {
    principal.apiKey = { organizationId: 'org-1' }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it.each([{ permissions: [] }, { permissions: [Permission.WRITE_BOXES] }])(
    'allows a permission subset $permissions',
    async ({ permissions }) => {
      expect((await create(permissions)).status).toBe(201)
      expect(createApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'delegated-key', permissions, undefined)
    },
  )

  it('preserves owner JWT grants', async () => {
    delete principal.apiKey

    expect((await create([Permission.DELETE_BOXES])).status).toBe(201)
  })

  it('still bounds a member by assigned role permissions', async () => {
    membership.role = OrganizationMemberRole.MEMBER

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it('allows a member grant only when both the key and assigned role hold it', async () => {
    membership = {
      role: OrganizationMemberRole.MEMBER,
      assignedRoles: [{ permissions: [Permission.WRITE_BOXES] }],
    }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(201)
  })

  describe.each(['/api-keys/target-key', '/api-keys/owner-1/target-key'])('revocation through %s', (path) => {
    async function revoke(target = path) {
      const address = app.getHttpServer().address() as AddressInfo
      return fetch(`http://127.0.0.1:${address.port}${target}`, { method: 'DELETE' })
    }

    it.each([SystemRole.USER, SystemRole.ADMIN])(
      'refuses read-only, empty, legacy and box-only %s keys before deletion',
      async (role) => {
        principal.role = role
        for (const permissions of [undefined, [], [Permission.READ_MEMBERS], [Permission.WRITE_BOXES]]) {
          principal.apiKey = { organizationId: 'org-1', permissions }

          expect((await revoke()).status).toBe(403)
          expect(deleteApiKey).not.toHaveBeenCalled()
        }
      },
    )

    it.each([SystemRole.USER, SystemRole.ADMIN])('allows a member-write %s key', async (role) => {
      principal.role = role
      principal.apiKey = { organizationId: 'org-1', permissions: [Permission.WRITE_MEMBERS] }

      expect((await revoke()).status).toBe(204)
      expect(deleteApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'target-key')
    })

    it('requires member write even to revoke the calling key', async () => {
      const selfPath = path.replace('target-key', 'calling-key')
      principal.apiKey = { organizationId: 'org-1', name: 'calling-key', permissions: [Permission.READ_MEMBERS] }

      expect((await revoke(selfPath)).status).toBe(403)
      expect(deleteApiKey).not.toHaveBeenCalled()

      principal.apiKey = { organizationId: 'org-1', name: 'calling-key', permissions: [Permission.WRITE_MEMBERS] }
      expect((await revoke(selfPath)).status).toBe(204)
      expect(deleteApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'calling-key')
    })

    it.each([OrganizationMemberRole.OWNER, OrganizationMemberRole.MEMBER])(
      'preserves %s JWT revocation of their own keys',
      async (role) => {
        membership.role = role
        delete principal.apiKey

        expect((await revoke()).status).toBe(204)
        expect(deleteApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'target-key')
      },
    )

    it('preserves member key revocation within their own account when scoped', async () => {
      membership.role = OrganizationMemberRole.MEMBER
      principal.apiKey = { organizationId: 'org-1', permissions: [Permission.WRITE_MEMBERS] }

      expect((await revoke()).status).toBe(204)
      expect(deleteApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'target-key')
    })

    it('refuses a key without membership in its organization', async () => {
      principal.organizationId = 'org-2'
      principal.apiKey = { organizationId: 'org-2', permissions: [Permission.WRITE_MEMBERS] }

      expect((await revoke()).status).toBe(403)
      expect(deleteApiKey).not.toHaveBeenCalled()
    })

    it('refuses a read-only owner key deleting another user key', async () => {
      principal.apiKey = { organizationId: 'org-1', permissions: [Permission.READ_MEMBERS] }

      expect((await revoke('/api-keys/other-user/target-key')).status).toBe(403)
      expect(deleteApiKey).not.toHaveBeenCalled()
    })

    it.each([false, true])('retains member target-user isolation (JWT: %s)', async (jwt) => {
      membership.role = OrganizationMemberRole.MEMBER
      principal.apiKey = { organizationId: 'org-1', permissions: [Permission.WRITE_MEMBERS] }
      if (jwt) delete principal.apiKey

      expect((await revoke('/api-keys/other-user/target-key')).status).toBe(403)
      expect(deleteApiKey).not.toHaveBeenCalled()
    })

    it.each([false, true])('allows owner revocation of another user key (JWT: %s)', async (jwt) => {
      principal.apiKey = { organizationId: 'org-1', permissions: [Permission.WRITE_MEMBERS] }
      if (jwt) delete principal.apiKey

      expect((await revoke('/api-keys/other-user/target-key')).status).toBe(204)
      expect(deleteApiKey).toHaveBeenCalledWith('org-1', 'other-user', 'target-key')
    })
  })
})
