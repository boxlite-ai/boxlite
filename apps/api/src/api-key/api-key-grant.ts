/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

/**
 * The permissions a caller is allowed to put on a key it mints.
 *
 * An API key may only pass on what it already carries. Without that rule a
 * key minted for one resource could mint itself a key for every other one,
 * which would make its own permission set decorative — the caller reaching
 * this code is holding a credential, not sitting in a browser session, so
 * the credential is what bounds the grant.
 *
 * Interactive sessions keep the membership rule instead: an owner grants
 * anything the organization has, other members grant what their roles carry.
 * `null` means the caller may grant anything.
 */
export function grantablePermissions(authContext: OrganizationAuthContext): OrganizationResourcePermission[] | null {
  if (authContext.role === SystemRole.ADMIN) {
    return null
  }

  if (authContext.apiKey) {
    return authContext.apiKey.permissions
  }

  if (!authContext.organizationUser) {
    return []
  }

  if (authContext.organizationUser.role === OrganizationMemberRole.OWNER) {
    return null
  }

  return authContext.organizationUser.assignedRoles.flatMap((role) => role.permissions)
}

/** The requested permissions the caller may not grant, in request order. */
export function ungrantablePermissions(
  authContext: OrganizationAuthContext,
  requested: OrganizationResourcePermission[],
): OrganizationResourcePermission[] {
  const grantable = grantablePermissions(authContext)
  if (grantable === null) {
    return []
  }

  const allowed = new Set(grantable)
  return requested.filter((permission) => !allowed.has(permission))
}
