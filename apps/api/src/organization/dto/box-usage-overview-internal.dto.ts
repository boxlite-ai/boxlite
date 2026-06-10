/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type BoxUsageOverviewInternalDto = {
  currentCpuUsage: number
  currentMemoryUsage: number
  currentDiskUsage: number
}

export type PendingBoxUsageOverviewInternalDto = {
  pendingCpuUsage: number | null
  pendingMemoryUsage: number | null
  pendingDiskUsage: number | null
}

export type BoxUsageOverviewWithPendingInternalDto = BoxUsageOverviewInternalDto & PendingBoxUsageOverviewInternalDto
