/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import {
  alwaysGrantedPermissions,
  groupSelectionState,
  permissionActionLabel,
  selectableGroups,
  toggleGroup,
  togglePermission,
} from '@/lib/api-key-permissions'
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { describe, expect, it } from 'vitest'

const ALL = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)
const VOLUMES = [
  CreateApiKeyPermissionsEnum.READ_VOLUMES,
  CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
  CreateApiKeyPermissionsEnum.DELETE_VOLUMES,
]

describe('selectableGroups', () => {
  it('offers only the groups that are a choice', () => {
    expect(selectableGroups(ALL).map((group) => group.name)).toEqual(
      CREATE_API_KEY_PERMISSIONS_GROUPS.filter((group) => !group.alwaysGranted).map((group) => group.name),
    )
  })

  it('does not offer box access, which every key carries anyway', () => {
    expect(selectableGroups(ALL).flatMap((group) => group.permissions)).not.toContain(
      CreateApiKeyPermissionsEnum.WRITE_BOXES,
    )
  })

  it('drops a group the member cannot grant, and narrows one they hold in part', () => {
    const partial = selectableGroups([CreateApiKeyPermissionsEnum.READ_VOLUMES])

    expect(partial).toEqual([{ name: 'Volumes', permissions: [CreateApiKeyPermissionsEnum.READ_VOLUMES] }])
  })
})

describe('alwaysGrantedPermissions', () => {
  it('carries box access onto every key', () => {
    expect(alwaysGrantedPermissions(ALL)).toEqual([
      CreateApiKeyPermissionsEnum.WRITE_BOXES,
      CreateApiKeyPermissionsEnum.DELETE_BOXES,
    ])
  })

  it('never adds a permission the operator cannot grant', () => {
    expect(alwaysGrantedPermissions([CreateApiKeyPermissionsEnum.READ_VOLUMES])).toEqual([])
  })
})

describe('togglePermission', () => {
  it('grants a single volume permission without touching the others', () => {
    expect(togglePermission([], CreateApiKeyPermissionsEnum.READ_VOLUMES)).toEqual([
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
    ])
  })

  it('revokes an already-granted permission', () => {
    expect(togglePermission(VOLUMES, CreateApiKeyPermissionsEnum.DELETE_VOLUMES)).toEqual([
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
      CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
    ])
  })

  it('normalises the result to declaration order regardless of tick order', () => {
    const tickedBackwards = [
      CreateApiKeyPermissionsEnum.DELETE_VOLUMES,
      CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
    ].reduce<CreateApiKeyPermissionsEnum[]>(togglePermission, [])

    expect(tickedBackwards).toEqual(VOLUMES)
  })
})

describe('groupSelectionState', () => {
  it.each([
    ['none', []],
    ['partial', [CreateApiKeyPermissionsEnum.READ_VOLUMES]],
    ['all', VOLUMES],
  ])('reports %s', (expected, selected) => {
    expect(groupSelectionState(selected as CreateApiKeyPermissionsEnum[], VOLUMES)).toBe(expected)
  })
})

describe('toggleGroup', () => {
  it('fills in a partially-granted group', () => {
    expect(toggleGroup([CreateApiKeyPermissionsEnum.READ_VOLUMES], VOLUMES)).toEqual(VOLUMES)
  })

  it('clears a fully-granted group', () => {
    expect(toggleGroup(VOLUMES, VOLUMES)).toEqual([])
  })

  it('leaves the other groups alone', () => {
    const boxes = CREATE_API_KEY_PERMISSIONS_GROUPS[0].permissions

    expect(toggleGroup([...boxes, ...VOLUMES], VOLUMES)).toEqual(boxes)
  })
})

describe('permissionActionLabel', () => {
  it('renders the action, since the resource is already the group heading', () => {
    expect(VOLUMES.map(permissionActionLabel)).toEqual(['Read', 'Write', 'Delete'])
  })
})
