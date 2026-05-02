/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useContext } from 'react'
import { PlaygroundContext } from '@/contexts/PlaygroundContext'

export function usePlayground() {
  const context = useContext(PlaygroundContext)

  if (!context) {
    throw new Error('usePlayground must be used within a <PlaygroundProvider />')
  }

  return context
}
