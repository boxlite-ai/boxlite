/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type TemplateUsageOverviewInternalDto = {
  currentTemplateUsage: number
}

export type PendingTemplateUsageOverviewInternalDto = {
  pendingTemplateUsage: number | null
}

export type TemplateUsageOverviewWithPendingInternalDto = TemplateUsageOverviewInternalDto &
  PendingTemplateUsageOverviewInternalDto
