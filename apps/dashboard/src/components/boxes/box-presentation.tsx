/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { StatusIndicator } from '@/components/ResourceLayout'
import { Box, BoxProgressPhase, BoxState } from '@boxlite-ai/api-client'

/** Presentation only: lifecycle actions continue to use the domain predicates. */
function statusOf(box: Box): { label: string; color: string } {
  switch (box.state) {
    case BoxState.STARTED:
      return { label: 'Running', color: 'hsl(var(--success))' }
    case BoxState.STOPPED:
      return { label: 'Stopped', color: 'hsl(var(--muted-foreground))' }
    case BoxState.ERROR:
      return { label: 'Error', color: 'hsl(var(--destructive))' }
    case BoxState.CREATING:
      return {
        label: box.progress?.phase === BoxProgressPhase.PREPARING_IMAGE ? 'Pulling image' : 'Starting',
        color: 'hsl(var(--warning))',
      }
    case BoxState.STARTING:
    case BoxState.RESTORING:
      return { label: 'Starting', color: 'hsl(var(--warning))' }
    case BoxState.STOPPING:
      return { label: 'Stopping', color: 'hsl(var(--warning))' }
    case BoxState.DESTROYING:
      return { label: 'Deleting', color: 'hsl(var(--warning))' }
    case BoxState.RESIZING:
      return { label: 'Resizing', color: 'hsl(var(--warning))' }
    case BoxState.DESTROYED:
      return { label: 'Deleted', color: 'hsl(var(--muted-foreground))' }
    default:
      return { label: box.state ?? 'Unknown', color: 'hsl(var(--muted-foreground))' }
  }
}

export function BoxStatusIndicator({ box, className }: { box: Box; className?: string }) {
  return <StatusIndicator {...statusOf(box)} className={className} />
}
