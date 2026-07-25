/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AuthContext } from '../common/interfaces/auth-context.interface'
import type { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

export const BOXLITE_BOX_READ_PERMISSIONS: OrganizationResourcePermission[] = []
export const BOXLITE_BOX_WRITE_PERMISSIONS = [OrganizationResourcePermission.WRITE_BOXES]
export const BOXLITE_BOX_DELETE_PERMISSIONS = [OrganizationResourcePermission.DELETE_BOXES]

export function grantedBoxliteScopes(authContext: AuthContext, organizationUser?: OrganizationUser): string[] {
  if (!hasBoxReadAccess(authContext, organizationUser)) {
    return ['me:read']
  }

  const scopes = ['box:read', 'me:read']
  const permissions = effectiveBoxPermissions(authContext, organizationUser)

  if (permissions.has(OrganizationResourcePermission.WRITE_BOXES)) {
    scopes.splice(1, 0, 'box:write', 'box:exec')
  }
  if (permissions.has(OrganizationResourcePermission.DELETE_BOXES)) {
    scopes.splice(scopes.length - 1, 0, 'box:delete')
  }

  return scopes
}

function hasBoxReadAccess(authContext: AuthContext, organizationUser?: OrganizationUser): boolean {
  return (authContext.role === SystemRole.ADMIN && !authContext.apiKey) || organizationUser !== undefined
}

function effectiveBoxPermissions(
  authContext: AuthContext,
  organizationUser?: OrganizationUser,
): Set<OrganizationResourcePermission> {
  if (authContext.apiKey) {
    return new Set(authContext.apiKey.permissions ?? [])
  }

  if (authContext.role === SystemRole.ADMIN) {
    return new Set(BOXLITE_BOX_WRITE_PERMISSIONS.concat(BOXLITE_BOX_DELETE_PERMISSIONS))
  }

  if (organizationUser?.role === OrganizationMemberRole.OWNER) {
    return new Set(BOXLITE_BOX_WRITE_PERMISSIONS.concat(BOXLITE_BOX_DELETE_PERMISSIONS))
  }

  return new Set(organizationUser?.assignedRoles?.flatMap((role) => role.permissions) ?? [])
}
