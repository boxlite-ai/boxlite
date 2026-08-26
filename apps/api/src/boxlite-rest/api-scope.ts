/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Reflector } from '@nestjs/core'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'

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
 * snapshot operations are absent because the cloud does not serve them —
 * `GET /v1/config` reports the same thing through `capabilities`.
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
  'api_key:read',
  'api_key:write',
  'api_key:delete',
] as const

export type ApiScope = (typeof API_SCOPES)[number]

/** Declares which scope a route handler belongs to. */
export const RestApiScope = Reflector.createDecorator<ApiScope>()

/**
 * The permissions a caller must hold before a scope is theirs.
 *
 * An empty list means the routes behind that scope are reachable by any
 * authenticated credential — they declare no required permission, so the
 * resource guard passes them through. That is a statement about what the
 * server enforces today, not an aspiration: reporting `box:write` for a key
 * that can in fact create boxes is the whole point.
 *
 * `api-scope.spec.ts` reflects over the real route metadata and fails if any
 * entry here stops matching what the guards check.
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
  'api_key:read': [],
  'api_key:write': [],
  'api_key:delete': [],
}

/**
 * The scopes a caller holding `permissions` can exercise.
 *
 * `null` means the caller is not bounded by permissions at all — a system
 * admin, or an organization owner in an interactive session, both of whom the
 * resource guard passes before it ever looks at a required-permission list.
 */
export function resolveApiScopes(permissions: OrganizationResourcePermission[] | null): ApiScope[] {
  if (permissions === null) {
    return [...API_SCOPES]
  }

  const held = new Set(permissions)
  return API_SCOPES.filter((scope) => SCOPE_REQUIREMENTS[scope].every((permission) => held.has(permission)))
}
