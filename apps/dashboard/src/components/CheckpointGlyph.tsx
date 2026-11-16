/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { Checkpoint } from '@/api/checkpoint-types'
import { StatusIndicator } from './ResourceLayout'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { cn } from '@/lib/utils'

const COLORS: Record<Checkpoint['state'], string> = {
  ready: 'hsl(var(--success))',
  creating: 'hsl(var(--warning))',
  deleting: 'hsl(var(--warning))',
  failed: 'hsl(var(--destructive))',
}

/** The same disk-and-clock outline serves navigation, empty states and resource rows. */
export function CheckpointGlyph({
  state,
  size = 20,
  className,
}: {
  state?: Checkpoint['state']
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="9.5" cy="5" rx="6.5" ry="2.5" />
      <path d="M3 5v12c0 1.4 2.9 2.5 6.5 2.5H10M16 5v5M3 11c0 1.4 2.9 2.5 6.5 2.5H10" />
      <circle cx="17" cy="17" r="5" />
      <path d="M17 14v3l2 1" stroke={state ? COLORS[state] : undefined} />
    </svg>
  )
}

/** Status text and markers remain visible independently of decorative icon accents. */
export function CheckpointStatusIndicator({ checkpoint }: { checkpoint: Checkpoint }) {
  const failed = checkpoint.state === 'failed'
  const status = (
    <StatusIndicator
      label={checkpoint.state}
      color={COLORS[checkpoint.state] ?? 'hsl(var(--muted-foreground))'}
      tabIndex={failed && checkpoint.error_reason ? 0 : undefined}
      className={cn(
        checkpoint.state === 'creating' &&
          '[&>span:first-child]:animate-pulse motion-reduce:[&>span:first-child]:animate-none',
        failed &&
          checkpoint.error_reason &&
          'cursor-help focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4',
      )}
    />
  )
  if (!failed || !checkpoint.error_reason) return status
  return (
    <Tooltip>
      <TooltipTrigger asChild>{status}</TooltipTrigger>
      <TooltipContent className="max-w-sm break-words [overflow-wrap:anywhere]">
        {checkpoint.error_reason}
      </TooltipContent>
    </Tooltip>
  )
}
