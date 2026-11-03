/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'

// Shared feedback for copyable blocks; inline previews use the quiet treatment.
export function QuickstartCopyButton({
  copied,
  failed,
  onClick,
  className,
  quiet = false,
  label = 'Copy',
}: {
  copied: boolean
  /** A denied clipboard permission used to look exactly like an unclicked
   *  button. It is the one moment this screen cannot afford to be silent. */
  failed?: boolean
  onClick: () => void
  className?: string
  quiet?: boolean
  label?: string
}) {
  const accent = failed ? 'destructive' : 'success'
  return (
    <button
      type="button"
      onClick={onClick}
      style={
        quiet
          ? undefined
          : {
              boxShadow: copied || failed ? `3px 3px 0 hsl(var(--${accent}) / 0.35)` : '3px 3px 0 hsl(var(--border))',
            }
      }
      className={cn(
        'flex h-7 flex-none items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
        quiet
          ? 'min-w-10 rounded-none px-2 font-display text-xs tracking-normal transition-colors hover:bg-foreground/[0.06]'
          : 'min-w-[76px] border-2 bg-[hsl(var(--code-background))] px-[10px] text-label font-semibold uppercase tracking-[1px] transition-[color,border-color,background-color,transform,box-shadow] active:translate-x-px active:translate-y-px active:shadow-none',
        failed
          ? quiet
            ? 'text-destructive'
            : 'border-destructive bg-[hsl(var(--destructive)/0.14)] text-destructive'
          : copied
            ? quiet
              ? 'text-success'
              : 'border-success bg-[hsl(var(--success)/0.14)] text-success'
            : quiet
              ? 'text-muted-foreground hover:text-foreground'
              : 'border-border text-muted-foreground hover:border-brand hover:text-foreground',
        className,
      )}
    >
      {failed ? '✕ Blocked' : copied ? '✓ Copied' : label}
    </button>
  )
}
