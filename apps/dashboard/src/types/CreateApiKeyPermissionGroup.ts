/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-labs/api-client'

export interface CreateApiKeyPermissionGroup {
  name: string
  permissions: CreateApiKeyPermissionsEnum[]
}
