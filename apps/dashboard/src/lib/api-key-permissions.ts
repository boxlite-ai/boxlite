/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'

export type ApiKeyPermissionGroup = {
  name: string
  permissions: CreateApiKeyPermissionsEnum[]
}

export type GroupSelectionState = 'all' | 'partial' | 'none'

// Declaration order of the groups. Selections are normalised back to it so the
// POST /api-keys payload does not depend on the order the boxes were ticked.
const DECLARED_ORDER: CreateApiKeyPermissionsEnum[] = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap(
  (group) => group.permissions,
)

/**
 * The groups a member may actually grant, narrowed to the permissions they hold
 * themselves. A member whose role carries no volume permissions cannot mint a
 * key that has them (the API rejects it), so the option must not be offered.
 */
export function selectableGroups(available: CreateApiKeyPermissionsEnum[]): ApiKeyPermissionGroup[] {
  return CREATE_API_KEY_PERMISSIONS_GROUPS.map((group) => ({
    name: group.name,
    permissions: group.permissions.filter((permission) => available.includes(permission)),
  })).filter((group) => group.permissions.length > 0)
}

export function groupSelectionState(
  selected: CreateApiKeyPermissionsEnum[],
  groupPermissions: CreateApiKeyPermissionsEnum[],
): GroupSelectionState {
  const picked = groupPermissions.filter((permission) => selected.includes(permission)).length
  if (picked === 0) return 'none'
  return picked === groupPermissions.length ? 'all' : 'partial'
}

export function togglePermission(
  selected: CreateApiKeyPermissionsEnum[],
  permission: CreateApiKeyPermissionsEnum,
): CreateApiKeyPermissionsEnum[] {
  return selected.includes(permission)
    ? selected.filter((candidate) => candidate !== permission)
    : inDeclaredOrder([...selected, permission])
}

/** A partially-ticked group fills in; a fully-ticked one clears. */
export function toggleGroup(
  selected: CreateApiKeyPermissionsEnum[],
  groupPermissions: CreateApiKeyPermissionsEnum[],
): CreateApiKeyPermissionsEnum[] {
  return groupSelectionState(selected, groupPermissions) === 'all'
    ? selected.filter((permission) => !groupPermissions.includes(permission))
    : inDeclaredOrder([...selected, ...groupPermissions])
}

/** `read:volumes` renders as `Read` — the resource is already the group heading. */
export function permissionActionLabel(permission: CreateApiKeyPermissionsEnum): string {
  const action = permission.split(':')[0]
  return action.charAt(0).toUpperCase() + action.slice(1)
}

function inDeclaredOrder(permissions: CreateApiKeyPermissionsEnum[]): CreateApiKeyPermissionsEnum[] {
  return DECLARED_ORDER.filter((permission) => permissions.includes(permission))
}
