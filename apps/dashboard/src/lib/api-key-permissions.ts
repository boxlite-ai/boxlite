/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiKeyPermissionGroup, CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'

export type GroupSelectionState = 'all' | 'partial' | 'none'

// Declaration order of the groups. Selections are normalised back to it so the
// POST /api-keys payload does not depend on the order the boxes were ticked.
const DECLARED_ORDER: CreateApiKeyPermissionsEnum[] = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap(
  (group) => group.permissions,
)

/**
 * The groups the operator chooses from, narrowed to the permissions they hold
 * themselves. A member whose role carries no volume permissions cannot mint a
 * key that has them (the API rejects it), so the option must not be offered.
 *
 * Always-granted groups are excluded: they are not a choice.
 */
export function selectableGroups(available: CreateApiKeyPermissionsEnum[]): ApiKeyPermissionGroup[] {
  return CREATE_API_KEY_PERMISSIONS_GROUPS.filter((group) => !group.alwaysGranted)
    .map((group) => ({
      name: group.name,
      permissions: group.permissions.filter((permission) => available.includes(permission)),
    }))
    .filter((group) => group.permissions.length > 0)
}

/**
 * What every key gets without being asked. Still narrowed to what the operator
 * holds — adding a permission they cannot grant would come back 403 naming
 * something they never chose.
 */
export function alwaysGrantedPermissions(available: CreateApiKeyPermissionsEnum[]): CreateApiKeyPermissionsEnum[] {
  return inDeclaredOrder(
    CREATE_API_KEY_PERMISSIONS_GROUPS.filter((group) => group.alwaysGranted).flatMap((group) =>
      group.permissions.filter((permission) => available.includes(permission)),
    ),
  )
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
