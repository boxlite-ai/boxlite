/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteConfiguration } from '@boxlite-ai/api-client'

export type BoxCreateDefaults = {
  cpu: number
  memory: number
  disk: number
}

export type DashboardConfig = BoxliteConfiguration & {
  apiUrl: string
  boxCreateDefaults: BoxCreateDefaults
}
