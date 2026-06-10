/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import React from 'react'
import { type BreakdownSegment, stateBadgeVariant } from './adminHelpers'

export function AdminSectionFrame({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className={cn('p-4', contentClassName)}>{children}</div>
    </section>
  )
}

export function AdminStateBadge({ state, className }: { state: string; className?: string }) {
  return (
    <Badge variant={stateBadgeVariant(state)} className={cn('capitalize', className)}>
      {state?.replace(/_/g, ' ')}
    </Badge>
  )
}

export function BreakdownBar({
  segments,
  total,
  className,
}: {
  segments: BreakdownSegment[]
  total: number
  className?: string
}) {
  if (total <= 0) return null
  return (
    <div className={cn('flex h-1.5 overflow-hidden rounded-full bg-muted/40', className)}>
      {segments.map((s) => (
        <div
          key={s.key}
          className="h-full"
          style={{ width: `${(s.count / total) * 100}%`, backgroundColor: s.color }}
        />
      ))}
    </div>
  )
}

export function BreakdownLegend({ segments, className }: { segments: BreakdownSegment[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      {segments.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
          {s.count} {s.label}
        </span>
      ))}
    </div>
  )
}
