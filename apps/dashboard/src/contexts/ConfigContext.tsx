/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DashboardConfig } from '@/types/DashboardConfig'
import { createContext } from 'react'

export const ConfigContext = createContext<DashboardConfig | null>(null)
