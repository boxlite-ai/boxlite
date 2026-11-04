/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import type { AppDetail } from '@/lib/apps/types'
import { useElapsed } from './useElapsed'

// The header's live line while any author (agent, console) deploys: "Deploying #4 · build · 0:42".
// The step name is the control plane's; the elapsed time counts from when the deployment started.
export function DeployProgress({ deploying }: { deploying: NonNullable<AppDetail['deploying']> }) {
  const elapsed = useElapsed(deploying.since)
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2 font-mono text-meta text-warning"
      title={deploying.detail ?? undefined}
      data-testid="deploy-progress"
    >
      <Spinner className="size-3.5 shrink-0" />
      <span className="truncate">
        Deploying {deploying.id}
        {deploying.step ? ` · ${deploying.step}` : ' · queued'}
        {elapsed ? ` · ${elapsed}` : ''}
      </span>
    </span>
  )
}
