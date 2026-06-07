/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type SavedImageUsageOverviewInternalDto = {
  currentSavedImageUsage: number
}

export type PendingSavedImageUsageOverviewInternalDto = {
  pendingSavedImageUsage: number | null
}

export type SavedImageUsageOverviewWithPendingInternalDto = SavedImageUsageOverviewInternalDto &
  PendingSavedImageUsageOverviewInternalDto
