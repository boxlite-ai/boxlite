/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type OrganizationUsageQuotaType = 'cpu' | 'memory' | 'disk' | 'snapshot_count' | 'volume_count'
export type OrganizationUsageResourceType = 'box' | 'snapshot' | 'volume'

const QUOTA_TO_RESOURCE_MAP: Record<OrganizationUsageQuotaType, OrganizationUsageResourceType> = {
  cpu: 'box',
  memory: 'box',
  disk: 'box',
  snapshot_count: 'snapshot',
  volume_count: 'volume',
} as const

export function getResourceTypeFromQuota(quotaType: OrganizationUsageQuotaType): OrganizationUsageResourceType {
  return QUOTA_TO_RESOURCE_MAP[quotaType]
}
