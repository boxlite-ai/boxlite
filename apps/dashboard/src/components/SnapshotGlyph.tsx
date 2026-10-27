/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Snapshot } from '@/lib/cloudSnapshot'
import { cn } from '@/lib/utils'

// A thin disk and a clock share VolumeGlyph's perspective and stroke weight.
export function SnapshotGlyph({
  state,
  size = 64,
  className,
}: {
  state: Snapshot['status']
  size?: number
  className?: string
}) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 } as const
  const dashed = state === 'creating' ? { strokeDasharray: '3 3' } : {}

  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', className)} aria-hidden="true">
      <ellipse cx="28" cy="34" rx="21" ry="10" {...stroke} {...dashed} />
      {state === 'failed' ? (
        <>
          <path d="M7 34v2M7 40v2M49 34v8" {...stroke} />
          <path d="M4 36l6 4" stroke="hsl(var(--destructive))" strokeWidth={2} />
        </>
      ) : (
        <path d="M7 34v8M49 34v8" {...stroke} {...dashed} />
      )}
      <path d="M7 42a21 10 0 0 0 42 0" {...stroke} {...dashed} />
      <circle cx="47" cy="13" r="10" {...stroke} />
      <path d="M47 7v6l5 3" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
      {state === 'ready' && <ellipse cx="28" cy="34" rx="4" ry="2.2" fill="hsl(var(--brand))" />}
    </svg>
  )
}
