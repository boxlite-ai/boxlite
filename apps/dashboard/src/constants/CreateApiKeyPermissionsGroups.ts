/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'

export const CREATE_API_KEY_PERMISSIONS_GROUPS: { name: string; permissions: CreateApiKeyPermissionsEnum[] }[] = [
  {
    name: 'Boxes',
    permissions: [CreateApiKeyPermissionsEnum.WRITE_BOXES, CreateApiKeyPermissionsEnum.DELETE_BOXES],
  },
  {
    // Write creates and deletes catalog aliases without silent replacement.
    // Using an image records it without any of these.
    name: 'Images',
    permissions: [
      CreateApiKeyPermissionsEnum.READ_IMAGES,
      CreateApiKeyPermissionsEnum.WRITE_IMAGES,
      CreateApiKeyPermissionsEnum.DELETE_IMAGES,
    ],
  },
  {
    // So a key can manage its organization's registry logins, which is how
    // the SDK adds one. None of them reads a password back.
    name: 'Registries',
    permissions: [
      CreateApiKeyPermissionsEnum.READ_REGISTRIES,
      CreateApiKeyPermissionsEnum.WRITE_REGISTRIES,
      CreateApiKeyPermissionsEnum.DELETE_REGISTRIES,
    ],
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
