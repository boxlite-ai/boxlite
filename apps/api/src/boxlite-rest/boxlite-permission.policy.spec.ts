/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { ApiKey } from '../api-key/api-key.entity'
import type { AuthContext, OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import type { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { hasRequiredOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../user/enums/system-role.enum'
import {
  BOXLITE_BOX_READ_PERMISSIONS,
  BOXLITE_BOX_WRITE_PERMISSIONS,
  grantedBoxliteScopes,
} from './boxlite-permission.policy'

function apiKey(permissions: OrganizationResourcePermission[]): ApiKey {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    permissions,
  } as ApiKey
}

function organizationUser(
  role: OrganizationMemberRole,
  permissions: OrganizationResourcePermission[] = [],
): OrganizationUser {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role,
    assignedRoles: permissions.length > 0 ? [{ permissions }] : [],
  } as OrganizationUser
}

function authContext(options?: {
  role?: SystemRole
  keyPermissions?: OrganizationResourcePermission[]
  memberRole?: OrganizationMemberRole
  memberPermissions?: OrganizationResourcePermission[]
}): OrganizationAuthContext {
  const member = organizationUser(
    options?.memberRole ?? OrganizationMemberRole.MEMBER,
    options?.memberPermissions,
  )
  return {
    organizationId: 'org-1',
    organization: { id: 'org-1' },
    organizationUser: member,
    userId: 'user-1',
    email: 'user@example.com',
    role: options?.role ?? SystemRole.USER,
    apiKey: options?.keyPermissions === undefined ? undefined : apiKey(options.keyPermissions),
  } as OrganizationAuthContext
}

describe('BoxLite permission policy', () => {
  describe('hasRequiredOrganizationResourcePermissions', () => {
    it('allows organization members to use membership-only Box reads', () => {
      expect(hasRequiredOrganizationResourcePermissions(authContext(), BOXLITE_BOX_READ_PERMISSIONS)).toBe(true)
    })

    it('allows a member role with Box write permission to mutate boxes', () => {
      const context = authContext({ memberPermissions: [OrganizationResourcePermission.WRITE_BOXES] })

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(true)
    })

    it('fails closed when assigned-role permissions are unavailable', () => {
      const context = authContext()
      const member = context.organizationUser as OrganizationUser
      member.assignedRoles = undefined as never

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(false)
    })

    it('does not let an owner API key inherit the interactive owner bypass', () => {
      const context = authContext({
        memberRole: OrganizationMemberRole.OWNER,
        keyPermissions: [],
      })

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(false)
    })

    it('allows an owner API key when the key itself has Box write permission', () => {
      const context = authContext({
        memberRole: OrganizationMemberRole.OWNER,
        keyPermissions: [OrganizationResourcePermission.WRITE_BOXES],
      })

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(true)
    })

    it('does not let a system administrator API key bypass its own Box permissions', () => {
      const context = authContext({
        role: SystemRole.ADMIN,
        keyPermissions: [],
      })

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(false)
    })

    it('allows an interactive owner without assigned roles', () => {
      const context = authContext({ memberRole: OrganizationMemberRole.OWNER })

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_WRITE_PERMISSIONS)).toBe(true)
    })

    it('requires an organization membership even for membership-only reads', () => {
      const context = authContext()
      context.organizationUser = undefined

      expect(hasRequiredOrganizationResourcePermissions(context, BOXLITE_BOX_READ_PERMISSIONS)).toBe(false)
    })
  })

  describe('grantedBoxliteScopes', () => {
    it('maps an API key with both Box capabilities to the complete Box scope set', () => {
      const context = authContext({
        keyPermissions: [
          OrganizationResourcePermission.WRITE_BOXES,
          OrganizationResourcePermission.DELETE_BOXES,
        ],
      })

      expect(grantedBoxliteScopes(context, context.organizationUser)).toEqual([
        'box:read',
        'box:write',
        'box:exec',
        'box:delete',
        'me:read',
      ])
    })

    it('keeps an owner API key with no Box permissions read-only', () => {
      const context = authContext({
        memberRole: OrganizationMemberRole.OWNER,
        keyPermissions: [],
      })

      expect(grantedBoxliteScopes(context, context.organizationUser)).toEqual(['box:read', 'me:read'])
    })

    it('keeps a system administrator API key constrained by the key permissions', () => {
      const context = authContext({
        role: SystemRole.ADMIN,
        keyPermissions: [],
      })

      expect(grantedBoxliteScopes(context, context.organizationUser)).toEqual(['box:read', 'me:read'])
    })

    it('does not advertise Box access without an organization membership', () => {
      const context = authContext()
      context.organizationUser = undefined

      expect(grantedBoxliteScopes(context)).toEqual(['me:read'])
    })

    it('maps an interactive owner to all Box scopes', () => {
      const context = authContext({ memberRole: OrganizationMemberRole.OWNER })

      expect(grantedBoxliteScopes(context, context.organizationUser)).toEqual([
        'box:read',
        'box:write',
        'box:exec',
        'box:delete',
        'me:read',
      ])
    })

    it('maps assigned member permissions without advertising image scopes', () => {
      const context = authContext({ memberPermissions: [OrganizationResourcePermission.DELETE_BOXES] })

      expect(grantedBoxliteScopes(context, context.organizationUser)).toEqual(['box:read', 'box:delete', 'me:read'])
    })

    it('gives system administrators all Box scopes without an organization membership', () => {
      const context: AuthContext = {
        userId: 'admin-1',
        email: 'admin@example.com',
        role: SystemRole.ADMIN,
      }

      expect(grantedBoxliteScopes(context)).toEqual([
        'box:read',
        'box:write',
        'box:exec',
        'box:delete',
        'me:read',
      ])
    })
  })
})
