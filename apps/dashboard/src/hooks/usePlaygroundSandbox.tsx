/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PlaygroundSandboxContext } from '@/providers/PlaygroundSandboxProvider'
import { UseSandboxSessionResult } from '@/hooks/useSandboxSession'
import { useContext } from 'react'

export type UsePlaygroundSandboxResult = UseSandboxSessionResult

export function usePlaygroundSandbox(): UsePlaygroundSandboxResult {
  const context = useContext(PlaygroundSandboxContext)

  if (!context) {
    throw new Error('usePlaygroundSandbox must be used within a <PlaygroundSandboxProvider />')
  }

  return context
}
