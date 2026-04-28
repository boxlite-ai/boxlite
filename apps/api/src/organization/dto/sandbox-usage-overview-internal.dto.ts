/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type SandboxUsageOverviewInternalDto = {
  currentCpuUsage: number
  currentMemoryUsage: number
  currentDiskUsage: number
}

export type PendingSandboxUsageOverviewInternalDto = {
  pendingCpuUsage: number | null
  pendingMemoryUsage: number | null
  pendingDiskUsage: number | null
}

export type SandboxUsageOverviewWithPendingInternalDto = SandboxUsageOverviewInternalDto &
  PendingSandboxUsageOverviewInternalDto
