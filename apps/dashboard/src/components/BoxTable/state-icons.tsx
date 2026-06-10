/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '@boxlite-ai/api-client'
import { Loader2 } from 'lucide-react'

interface SquareProps {
  color: string
}

function Square({ color }: SquareProps) {
  return (
    <div className="w-4 h-4 p-1">
      <div className={`w-2 h-2 ${color} rounded-[2px]`} />
    </div>
  )
}

export const STATE_ICONS: Record<BoxState | 'RECOVERY', React.ReactNode> = {
  [BoxState.UNKNOWN]: <Square color="bg-muted-foreground/20" />,
  [BoxState.CREATING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.STARTING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.STARTED]: <Square color="bg-green-600" />,
  [BoxState.STOPPING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.STOPPED]: <Square color="bg-muted-foreground/50" />,
  [BoxState.DESTROYING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.DESTROYED]: <Square color="bg-muted-foreground/20" />,
  [BoxState.ERROR]: <Square color="bg-destructive" />,
  [BoxState.BUILD_FAILED]: <Square color="bg-destructive" />,
  [BoxState.BUILDING_ARTIFACT]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.PENDING_BUILD]: <Square color="bg-muted-foreground/20" />,
  [BoxState.ARCHIVED]: <Square color="bg-muted-foreground/20" />,
  [BoxState.ARCHIVING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.RESTORING]: <Loader2 className="w-3 h-3 animate-spin" />,
  [BoxState.RESIZING]: <Loader2 className="w-3 h-3 animate-spin" />,
  RECOVERY: <Square color="bg-yellow-600" />,
}
