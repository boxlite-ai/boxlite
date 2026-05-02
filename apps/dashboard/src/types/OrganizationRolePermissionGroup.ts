/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'

export interface OrganizationRolePermissionGroup {
  name: string
  permissions: OrganizationRolePermissionsEnum[]
}
