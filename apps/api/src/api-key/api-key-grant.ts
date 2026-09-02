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
 * The permissions the resource guard honours for this caller — what the caller
 * effectively holds.
 *
 * Two callers read it: key issuance, which may not grant beyond it, and
 * `GET /v1/me`, which reports the scopes it unlocks.
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
export function effectivePermissions(authContext: OrganizationAuthContext): OrganizationResourcePermission[] | null {
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

/**
 * The latest expiry a key minted by this caller may carry, or undefined for
 * an unbounded caller (an interactive session, or a key that does not expire).
 *
 * A child that outlives its expiring parent would let the credential escape
 * its own revocation-by-expiry, so callers refuse a requested expiry past
 * this bound and fall back to it when no expiry was requested.
 */
export function expiryBoundOf(authContext: OrganizationAuthContext): Date | undefined {
  return authContext.apiKey?.expiresAt
}

/** The requested permissions the caller may not grant, in request order. */
export function ungrantablePermissions(
  authContext: OrganizationAuthContext,
  requested: OrganizationResourcePermission[],
): OrganizationResourcePermission[] {
  const grantable = effectivePermissions(authContext)
  if (grantable === null) {
    return []
  }

  const allowed = new Set(grantable)
  return requested.filter((permission) => !allowed.has(permission))
}
