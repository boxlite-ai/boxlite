/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CopyableValueProps extends Omit<React.ComponentProps<'div'>, 'children' | 'onCopy'> {
  displayValue: React.ReactNode
  copyValue?: string
  copyLabel?: string
  copied?: boolean
  onCopy?: (value: string) => void
  valueClassName?: string
  valueProps?: Omit<React.ComponentProps<'span'>, 'children' | 'className'> & {
    className?: string
  }
  actions?: React.ReactNode
  actionsClassName?: string
}

function CopyableValue({
  className,
  displayValue,
  copyValue,
  copyLabel = 'value',
  copied,
  onCopy,
  valueClassName,
  valueProps,
  actions,
  actionsClassName,
  ...props
}: CopyableValueProps) {
  const { className: valuePropsClassName, ...restValueProps } = valueProps ?? {}
  let copyAction: React.ReactNode = null

  if (copyValue !== undefined && onCopy) {
    const valueToCopy = copyValue
    copyAction = copied ? (
      <CheckIcon className="h-4 w-4 shrink-0" />
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${copyLabel}`}
        className="-mr-1 h-6 w-6 shrink-0 text-current hover:bg-green-200/70 hover:text-current dark:hover:bg-green-800/70"
        onClick={() => onCopy(valueToCopy)}
      >
        <CopyIcon className="h-4 w-4" />
      </Button>
    )
  }

  return (
    <div
      data-slot="copyable-value"
      className={cn(
        'flex min-w-0 items-center gap-2 overflow-hidden rounded-md bg-green-100 p-3 text-green-600 dark:bg-green-900/50 dark:text-green-400',
        className,
      )}
      {...props}
    >
      <span
        data-slot="copyable-value-text"
        className={cn(
          'min-w-0 flex-1 overflow-x-auto whitespace-nowrap pr-2 cursor-text select-all',
          valueClassName,
          valuePropsClassName,
        )}
        {...restValueProps}
      >
        {displayValue}
      </span>
      {actions ? (
        <div className={cn('flex shrink-0 items-center gap-2', actionsClassName)}>{actions}</div>
      ) : copyAction ? (
        copyAction
      ) : null}
    </div>
  )
}

export { CopyableValue }
