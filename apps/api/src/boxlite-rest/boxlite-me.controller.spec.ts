/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiKey } from '../api-key/api-key.entity'
import { AuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteMeController } from './boxlite-me.controller'

describe('BoxliteMeController', () => {
  function makeController(
    orgFindByUser: jest.Mock = jest.fn().mockResolvedValue([
      {
        organization: { id: '11111111-1111-1111-1111-111111111111' },
        organizationUser: {
          organizationId: '11111111-1111-1111-1111-111111111111',
          userId: 'user-1',
          role: OrganizationMemberRole.MEMBER,
          assignedRoles: [],
        },
        isDefaultForAuthenticatedUser: true,
      },
    ]),
  ): BoxliteMeController {
    const organizationService = { findByUserWithDefaultFlag: orgFindByUser } as unknown as OrganizationService
    return new BoxliteMeController(organizationService)
  }

  function apiKeyContext(expiresAt?: Date, permissions: OrganizationResourcePermission[] = []): AuthContext {
    const apiKey = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      name: 'key-531',
      expiresAt,
      permissions,
    } as ApiKey
    return {
      userId: 'user-1',
      email: 'svc@example.com',
      role: 'user' as AuthContext['role'],
      apiKey,
      organizationId: apiKey.organizationId,
    }
  }

  describe('GET /v1/me — expires_at is sourced from ApiKey.expiresAt', () => {
    it('returns the API key expiry as an ISO string (same field the dashboard renders)', async () => {
      const expiresAt = new Date('2026-06-07T12:00:00.000Z')
      const result = await makeController().getMe(apiKeyContext(expiresAt))

      expect(result.principal_type).toBe('service_account')
      expect(result.expires_at).toBe(expiresAt.toISOString())
    })

    it('returns null for a non-expiring API key (expiresAt unset)', async () => {
      const result = await makeController().getMe(apiKeyContext(undefined))

      expect(result.expires_at).toBeNull()
    })

    it('returns null for an interactive user session (no API key)', async () => {
      const findByUser = jest.fn().mockResolvedValue([])
      const ctx: AuthContext = {
        userId: 'user-2',
        email: 'human@example.com',
        role: 'user' as AuthContext['role'],
      }

      const result = await makeController(findByUser).getMe(ctx)

      expect(result.principal_type).toBe('user')
      expect(result.expires_at).toBeNull()
    })
  })

  describe('GET /v1/me — scopes reflect effective Box permissions', () => {
    it('does not advertise write, exec, delete, or image scopes to a read-only API key', async () => {
      const result = await makeController().getMe(apiKeyContext())

      expect(result.scopes).toEqual(['box:read', 'me:read'])
    })

    it('maps Box write permission to write and exec scopes without advertising delete', async () => {
      const result = await makeController().getMe(
        apiKeyContext(undefined, [OrganizationResourcePermission.WRITE_BOXES]),
      )

      expect(result.scopes).toEqual(['box:read', 'box:write', 'box:exec', 'me:read'])
    })

    it('does not advertise Box scopes when the API key owner is no longer an organization member', async () => {
      const result = await makeController(jest.fn().mockResolvedValue([])).getMe(apiKeyContext())

      expect(result.scopes).toEqual(['me:read'])
    })

    it('does not let a system administrator API key advertise permissions absent from the key', async () => {
      const context = apiKeyContext()
      context.role = SystemRole.ADMIN

      const result = await makeController().getMe(context)

      expect(result.scopes).toEqual(['box:read', 'me:read'])
    })

    it('uses the selected organization membership for an interactive user', async () => {
      const findByUser = jest.fn().mockResolvedValue([
        {
          organization: { id: 'org-2' },
          isDefaultForAuthenticatedUser: true,
          organizationUser: {
            role: OrganizationMemberRole.MEMBER,
            assignedRoles: [{ permissions: [OrganizationResourcePermission.DELETE_BOXES] }],
          },
        },
      ])
      const ctx: AuthContext = {
        userId: 'user-2',
        email: 'human@example.com',
        role: 'user' as AuthContext['role'],
      }

      const result = await makeController(findByUser).getMe(ctx)

      expect(result.scopes).toEqual(['box:read', 'box:delete', 'me:read'])
    })

    it('does not advertise Box scopes to an interactive user without an organization membership', async () => {
      const context: AuthContext = {
        userId: 'user-2',
        email: 'human@example.com',
        role: 'user' as AuthContext['role'],
      }

      const result = await makeController(jest.fn().mockResolvedValue([])).getMe(context)

      expect(result.scopes).toEqual(['me:read'])
    })
  })
})
