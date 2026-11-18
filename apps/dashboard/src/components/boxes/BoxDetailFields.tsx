/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Inspector headings use spacing; the containing panel provides the boundary. */
export function BoxDetailHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-1 flex min-h-9 items-center justify-between gap-3">
      <h2 className="text-em font-semibold leading-6 text-foreground">{title}</h2>
      {action}
    </div>
  )
}

/** A description-list row; long values wrap while labels and controls stay aligned. */
export function BoxDetailField({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className="grid min-h-9 grid-cols-[80px_minmax(0,1fr)] items-baseline gap-4 py-2 sm:grid-cols-[88px_minmax(0,1fr)]">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 font-mono text-body [overflow-wrap:anywhere]', className)}>{children}</dd>
    </div>
  )
}
