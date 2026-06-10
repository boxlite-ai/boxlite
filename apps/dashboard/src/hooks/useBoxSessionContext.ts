/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IBoxSessionContext, BoxSessionContext } from '@/contexts/BoxSessionContext'
import { useContext } from 'react'

export function useBoxSessionContext(): IBoxSessionContext {
  const context = useContext(BoxSessionContext)
  if (!context) {
    throw new Error('useBoxSessionContext must be used within a BoxSessionProvider')
  }
  return context
}
