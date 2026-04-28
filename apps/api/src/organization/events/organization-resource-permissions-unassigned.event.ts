/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'

export class OrganizationResourcePermissionsUnassignedEvent {
  constructor(
    public readonly entityManager: EntityManager,
    public readonly organizationId: string,
    public readonly userId: string,
    public readonly unassignedPermissions: OrganizationResourcePermission[],
  ) {}
}
