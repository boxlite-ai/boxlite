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
  iconOnly?: boolean
  pill?: boolean
}

function getStateTint(state: BoxStateType, recoverable?: boolean): string {
  if (recoverable) return 'border-yellow-600/30 bg-yellow-600/10 text-yellow-700 dark:text-yellow-400'
  switch (state) {
    case BoxStateType.STARTED:
      return 'border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400'
    case BoxStateType.ERROR:
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

export function BoxState({ state, errorReason, recoverable, className, iconOnly, pill }: BoxStateProps) {
  if (!state) return null
  const stateIcon = recoverable ? STATE_ICONS['RECOVERY'] : STATE_ICONS[state] || STATE_ICONS[BoxStateType.UNKNOWN]
  const label = getStateLabel(state)

  if (pill) {
    const badge = (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
          getStateTint(state, recoverable),
          className,
        )}
      >
        <span className="flex size-3 items-center justify-center">{stateIcon}</span>
        {label}
      </span>
    )
    if (state === BoxStateType.ERROR && errorReason) {
      return (
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>
            <p className="max-w-[300px]">{errorReason}</p>
          </TooltipContent>
        </Tooltip>
      )
    }
    return badge
  }

  if (iconOnly) {
    const tip = state === BoxStateType.ERROR && errorReason ? errorReason : label
    return (
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>
          <div className={cn('w-4 h-4 flex items-center justify-center flex-shrink-0', className)}>{stateIcon}</div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-[300px]">{tip}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  if (state === BoxStateType.ERROR) {
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
