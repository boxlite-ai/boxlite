/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type OrganizationUsageQuotaType = 'cpu' | 'memory' | 'disk' | 'template_count' | 'volume_count'
export type OrganizationUsageResourceType = 'sandbox' | 'template' | 'volume'

const QUOTA_TO_RESOURCE_MAP: Record<OrganizationUsageQuotaType, OrganizationUsageResourceType> = {
  cpu: 'sandbox',
  memory: 'sandbox',
  disk: 'sandbox',
  template_count: 'template',
  volume_count: 'volume',
} as const

export function getResourceTypeFromQuota(quotaType: OrganizationUsageQuotaType): OrganizationUsageResourceType {
  return QUOTA_TO_RESOURCE_MAP[quotaType]
}
