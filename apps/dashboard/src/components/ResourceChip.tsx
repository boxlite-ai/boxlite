/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { CpuIcon, HardDriveIcon, MemoryStickIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  resource: 'cpu' | 'memory' | 'disk'
  value: number
  unit?: string
  icon?: ReactNode
  className?: string
}

const resourceUnits = {
  cpu: 'vCPU',
  memory: 'GiB',
  disk: 'GiB',
}

const resourceIcons = {
  cpu: CpuIcon,
  memory: MemoryStickIcon,
  disk: HardDriveIcon,
}

export function ResourceChip({ resource, value, unit, icon, className }: Props) {
  const resourceUnit = unit ?? resourceUnits[resource]
  const ResourceIcon = resourceIcons[resource]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border border-border/70 bg-muted/25 px-1.5 py-0.5 text-xs leading-none text-foreground dark:border-white/10 dark:bg-muted/20',
        className,
      )}
    >
      {icon === null
        ? null
        : (icon ?? <ResourceIcon className="size-3.5 flex-shrink-0 text-muted-foreground" strokeWidth={1.75} />)}
      <span className="font-medium tabular-nums">{value}</span>
      <span className="text-muted-foreground">{resourceUnit}</span>
    </span>
  )
}
