/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegionsContext } from '@/contexts/RegionsContext'
import { useContext } from 'react'

export function useRegions() {
  const context = useContext(RegionsContext)

  if (!context) {
    throw new Error('useRegions must be used within a RegionsProvider')
  }

  return context
}
