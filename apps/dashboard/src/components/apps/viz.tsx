/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// A visual piece the App pages add, in the console's language: a small bordered
// uppercase tag (as "CURRENT" on plans). The Overview's screenshot and stack are
// OverviewHero.tsx, its traffic chart TrafficPanel.tsx.

/** Small bordered uppercase tag, as "CURRENT" / "BY REQUEST" on the plan cards. */
export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'good' | 'bad' | 'warn'
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center whitespace-nowrap border px-[6px] py-[2px] font-mono text-[9px] uppercase leading-none tracking-[1px]',
        tone === 'neutral' && 'border-border text-muted-foreground',
        tone === 'brand' && 'border-brand/50 text-brand',
        tone === 'good' && 'border-success/50 text-success',
        tone === 'bad' && 'border-destructive/50 text-destructive',
        tone === 'warn' && 'border-warning/50 text-warning',
      )}
    >
      {children}
    </span>
  )
}
