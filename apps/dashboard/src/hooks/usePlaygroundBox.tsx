/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PlaygroundBoxContext } from '@/providers/PlaygroundBoxProvider'
import { UseBoxSessionResult } from '@/hooks/useBoxSession'
import { useContext } from 'react'

export type UsePlaygroundBoxResult = UseBoxSessionResult

export function usePlaygroundBox(): UsePlaygroundBoxResult {
  const context = useContext(PlaygroundBoxContext)

  if (!context) {
    throw new Error('usePlaygroundBox must be used within a <PlaygroundBoxProvider />')
  }

  return context
}
