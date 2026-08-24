/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { describe, expect, it } from 'vitest'
import { CREATE_API_KEY_PERMISSIONS_GROUPS } from './CreateApiKeyPermissionsGroups'

// What the console can actually hand out: Keys.tsx flattens these groups into
// the permission set offered by the create dialog, so a permission missing here
// is a permission no customer can obtain without hand-crafting an API call.
const offeredByConsole = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)

describe('console-issuable API key permissions', () => {
  it.each([
    ['GET /v1/volumes', CreateApiKeyPermissionsEnum.READ_VOLUMES],
    ['POST /v1/volumes', CreateApiKeyPermissionsEnum.WRITE_VOLUMES],
    ['DELETE /v1/volumes/:id', CreateApiKeyPermissionsEnum.DELETE_VOLUMES],
  ])('offers the permission the volume API requires for %s', (_endpoint, permission) => {
    expect(offeredByConsole).toContain(permission)
  })

  it('offers each volume permission as an individually selectable option', () => {
    const volumeGroup = CREATE_API_KEY_PERMISSIONS_GROUPS.find((group) =>
      group.permissions.some((permission) => permission.endsWith(':volumes')),
    )

    expect(volumeGroup?.permissions).toEqual([
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
      CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
      CreateApiKeyPermissionsEnum.DELETE_VOLUMES,
    ])
  })
})
