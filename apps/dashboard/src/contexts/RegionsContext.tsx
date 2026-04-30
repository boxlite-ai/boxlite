/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Region } from '@boxlite-labs/api-client'
import { createContext } from 'react'

export interface IRegionsContext {
  sharedRegions: Region[]
  loadingSharedRegions: boolean
  availableRegions: Region[]
  loadingAvailableRegions: boolean
  customRegions: Region[]
  refreshAvailableRegions: () => Promise<Region[]>
  getRegionName: (regionId: string) => string | undefined
}

export const RegionsContext = createContext<IRegionsContext | undefined>(undefined)
