/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const UPGRADE_TIER_MESSAGE = (dashboardUrl: string) =>
  `To increase concurrency limits, upgrade your organization's Tier by visiting ${dashboardUrl}/limits.`

export const STORAGE_LIMIT_MESSAGE = 'Consider deleting unused Boxes or increasing your storage limit.'

export const PER_BOX_LIMIT_MESSAGE =
  'Need higher resource limits per-box? Contact us at support@boxlite.io and let us know about your use case.'
