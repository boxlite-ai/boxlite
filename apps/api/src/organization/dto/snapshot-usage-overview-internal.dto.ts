/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type SnapshotUsageOverviewInternalDto = {
  currentSnapshotUsage: number
}

export type PendingSnapshotUsageOverviewInternalDto = {
  pendingSnapshotUsage: number | null
}

export type SnapshotUsageOverviewWithPendingInternalDto = SnapshotUsageOverviewInternalDto &
  PendingSnapshotUsageOverviewInternalDto
