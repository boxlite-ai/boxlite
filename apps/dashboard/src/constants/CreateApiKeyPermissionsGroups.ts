/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'

export type ApiKeyPermissionGroup = {
  name: string
  permissions: CreateApiKeyPermissionsEnum[]
  /**
   * Carried by every key without being asked for. Box access is what an API
   * key is for — a key that cannot manage boxes has no use — so offering it as
   * a choice only invites someone to create a key that does nothing.
   */
  alwaysGranted?: boolean
}

// The permissions involved in issuing a key. A permission missing from this
// list is one no customer can obtain from the console, however well the API
// supports it — the dialog only ever submits what these groups declare.
export const CREATE_API_KEY_PERMISSIONS_GROUPS: ApiKeyPermissionGroup[] = [
  {
    name: 'Boxes',
    permissions: [CreateApiKeyPermissionsEnum.WRITE_BOXES, CreateApiKeyPermissionsEnum.DELETE_BOXES],
    alwaysGranted: true,
  },
  {
    name: 'Volumes',
    permissions: [
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
      CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
      CreateApiKeyPermissionsEnum.DELETE_VOLUMES,
    ],
  },
]
