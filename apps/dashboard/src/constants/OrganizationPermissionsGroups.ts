/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'

export const ORGANIZATION_ROLE_PERMISSIONS_GROUPS: { name: string; permissions: OrganizationRolePermissionsEnum[] }[] =
  [
    {
      name: 'Boxes',
      permissions: [OrganizationRolePermissionsEnum.WRITE_BOXES, OrganizationRolePermissionsEnum.DELETE_BOXES],
    },
    {
      // No write: an image enters the catalog by being used, so creating a box
      // is what writes it. There is no route to grant.
      name: 'Images',
      permissions: [OrganizationRolePermissionsEnum.READ_IMAGES, OrganizationRolePermissionsEnum.DELETE_IMAGES],
    },
    {
      name: 'Registries',
      permissions: [
        OrganizationRolePermissionsEnum.WRITE_REGISTRIES,
        OrganizationRolePermissionsEnum.DELETE_REGISTRIES,
      ],
    },
    {
      name: 'Volumes',
      permissions: [
        OrganizationRolePermissionsEnum.READ_VOLUMES,
        OrganizationRolePermissionsEnum.WRITE_VOLUMES,
        OrganizationRolePermissionsEnum.DELETE_VOLUMES,
      ],
    },
  ]
