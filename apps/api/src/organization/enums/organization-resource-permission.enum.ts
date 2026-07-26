/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/*
  When exposing a permission in a dashboard workflow, update that workflow's
  permission group.
*/
export enum OrganizationResourcePermission {
  // docker registries
  WRITE_REGISTRIES = 'write:registries',
  DELETE_REGISTRIES = 'delete:registries',

  // templates
  WRITE_TEMPLATES = 'write:templates',
  DELETE_TEMPLATES = 'delete:templates',

  // boxes
  WRITE_BOXES = 'write:boxes',
  DELETE_BOXES = 'delete:boxes',

  // volumes
  READ_VOLUMES = 'read:volumes',
  WRITE_VOLUMES = 'write:volumes',
  DELETE_VOLUMES = 'delete:volumes',

  // regions
  WRITE_REGIONS = 'write:regions',
  DELETE_REGIONS = 'delete:regions',

  // runners
  READ_RUNNERS = 'read:runners',
  WRITE_RUNNERS = 'write:runners',
  DELETE_RUNNERS = 'delete:runners',

  // audit
  READ_AUDIT_LOGS = 'read:audit_logs',
}

// Keep legacy permission values in the internal enum while stored roles, API keys,
// and active route guards can still reference them. This list is the public
// boundary for new assignments and can grow as those capabilities ship.
export const ASSIGNABLE_ORGANIZATION_RESOURCE_PERMISSIONS = [
  OrganizationResourcePermission.WRITE_BOXES,
  OrganizationResourcePermission.DELETE_BOXES,
] as const satisfies readonly OrganizationResourcePermission[]
