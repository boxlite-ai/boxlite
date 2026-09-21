/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Reflector } from '@nestjs/core'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

/**
 * The scope vocabulary this deployment speaks, as reported by `GET /v1/me`.
 *
 * A scope names a resource and an action on the BoxLite REST surface. It is
 * not the same vocabulary as `OrganizationResourcePermission`: permissions are
 * how the cloud deployment enforces access, while scopes describe the surface
 * itself, so a single-tenant server with no permission model at all can still
 * answer the question "what can this credential do".
 *
 * Only operations this deployment actually serves belong here. Image and
 * snapshot operations are absent because the cloud serves no route for either.
 * `GET /v1/config` says as much for snapshots, through
 * `capabilities.snapshots_enabled`; images have no capability flag at all, so
 * this list is the only place their absence is stated.
 */
export const API_SCOPES = [
  'me:read',
  'box:read',
  'box:write',
  'box:exec',
  'box:delete',
  'volume:read',
  'volume:write',
  'volume:delete',
] as const

export type ApiScope = (typeof API_SCOPES)[number]

/** Declares which scope a route handler belongs to. */
export const RestApiScope = Reflector.createDecorator<ApiScope>()

/**
 * The permissions a caller must hold before a scope is theirs.
 *
 * An empty list means the routes behind that scope name no required
 * permission, so the resource guard stops asking once it has admitted the
 * caller. It does not mean the routes are open to anyone authenticated: the
 * guard admits a caller only after resolving a membership for them, which
 * this table cannot express. `apiScopesFor` therefore over-reports the
 * empty-list scopes to a caller who has no membership at all — see the
 * divergence recorded in `api-scope.spec.ts`.
 *
 * That spec also reflects over the real route metadata and fails if any entry
 * here stops matching the permissions the guards check.
 */
export const SCOPE_REQUIREMENTS: Record<ApiScope, OrganizationResourcePermission[]> = {
  'me:read': [],
  'box:read': [],
  'box:write': [],
  'box:exec': [],
  'box:delete': [],
  'volume:read': [OrganizationResourcePermission.READ_VOLUMES],
  'volume:write': [OrganizationResourcePermission.WRITE_VOLUMES],
  'volume:delete': [OrganizationResourcePermission.DELETE_VOLUMES],
}

/**
 * The scopes `GET /v1/me` reports for this caller.
 *
 * Derived from what `OrganizationResourceActionGuard` will actually honour, so
 * a scope is listed exactly when the routes behind it are reachable — the
 * point of the endpoint is that a client can trust the list instead of
 * discovering a missing permission at first use.
 *
 * The caller must already carry its `organizationUser` when it has one:
 * membership is what bounds an interactive session, so an owner arriving as a
 * bare user id would be told they hold nothing.
 */
export function apiScopesFor(authContext: OrganizationAuthContext): ApiScope[] {
  const held = honouredPermissions(authContext)
  if (held === null) {
    return [...API_SCOPES]
  }

  return API_SCOPES.filter((scope) => SCOPE_REQUIREMENTS[scope].every((permission) => held.has(permission)))
}

/**
 * The permissions the resource guard honours for this caller, or `null` for a
 * caller it does not bound by permissions at all — a system admin, or an
 * organization owner in an interactive session, both of whom the guard passes
 * before it ever looks at a required-permission list.
 *
 * Follows `OrganizationResourceActionGuard.canActivate` on which permissions
 * bound a caller, including its rule that an owner holding an API key is
 * bounded by the key: the credential is what reaches the route, so the
 * credential is what the report has to describe.
 *
 * It does not reproduce the guard's earlier membership precondition, which
 * refuses a caller carrying no `organizationUser` outright. Such a caller is
 * reported an empty permission set here, which still unlocks every scope whose
 * requirement list is empty.
 */
function honouredPermissions(authContext: OrganizationAuthContext): Set<OrganizationResourcePermission> | null {
  if (authContext.role === SystemRole.ADMIN) {
    return null
  }

  if (authContext.apiKey) {
    return new Set(authContext.apiKey.permissions)
  }

  if (!authContext.organizationUser) {
    return new Set()
  }

  if (authContext.organizationUser.role === OrganizationMemberRole.OWNER) {
    return null
  }

  return new Set(authContext.organizationUser.assignedRoles.flatMap((role) => role.permissions))
}
