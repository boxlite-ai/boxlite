/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'

// Shared by every copyable block in Quickstart, so a new one cannot drift into
// its own button style.
export function QuickstartCopyButton({
  copied,
  onClick,
  className,
}: {
  copied: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        boxShadow: copied ? '3px 3px 0 hsl(var(--success) / 0.35)' : '3px 3px 0 hsl(var(--border))',
      }}
      className={cn(
        'flex h-7 min-w-[76px] flex-none items-center justify-center border-2 bg-[hsl(var(--code-background))] px-[10px] text-[10px] font-semibold uppercase tracking-[1px] transition-[color,border-color,background-color,transform,box-shadow] active:translate-x-px active:translate-y-px active:shadow-none',
        copied
          ? 'border-success bg-[hsl(var(--success)/0.14)] text-success'
          : 'border-border text-muted-foreground hover:border-brand hover:text-foreground',
        className,
      )}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}
