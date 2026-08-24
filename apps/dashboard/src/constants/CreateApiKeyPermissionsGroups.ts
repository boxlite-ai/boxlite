/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'

// The permissions the create-key dialog offers, grouped by the resource they
// govern. A permission missing from this list is one no customer can obtain
// from the console, however well the API supports it — the dialog only ever
// submits what these groups declare.
export const CREATE_API_KEY_PERMISSIONS_GROUPS: { name: string; permissions: CreateApiKeyPermissionsEnum[] }[] = [
  {
    name: 'Boxes',
    permissions: [CreateApiKeyPermissionsEnum.WRITE_BOXES, CreateApiKeyPermissionsEnum.DELETE_BOXES],
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
