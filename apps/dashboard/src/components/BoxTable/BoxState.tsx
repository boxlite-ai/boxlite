/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { BoxState as BoxStateType } from '@boxlite-ai/api-client'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { getStateLabel } from './constants'
import { STATE_ICONS } from './state-icons'

interface BoxStateProps {
  state?: BoxStateType
  errorReason?: string
  recoverable?: boolean
  className?: string
}

export function BoxState({ state, errorReason, recoverable, className }: BoxStateProps) {
  if (!state) return null
  const stateIcon = recoverable ? STATE_ICONS['RECOVERY'] : STATE_ICONS[state] || STATE_ICONS[BoxStateType.UNKNOWN]
  const label = getStateLabel(state)

  if (state === BoxStateType.ERROR || state === BoxStateType.BUILD_FAILED) {
    const errorColor = recoverable ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'

    const errorContent = (
      <div className={cn('flex items-center gap-1', errorColor, className)}>
        <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">{stateIcon}</div>
        <span className="truncate">{label}</span>
      </div>
    )

    if (!errorReason) {
      return errorContent
    }

    return (
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>{errorContent}</TooltipTrigger>
        <TooltipContent>
          <p className="max-w-[300px]">{errorReason}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div
      className={cn('flex items-center gap-1', state === BoxStateType.ARCHIVED && 'text-muted-foreground', className)}
    >
      <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">{stateIcon}</div>
      <span className="truncate">{label}</span>
    </div>
  )
}
