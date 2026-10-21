/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describeChange, type AppDetail } from '@/lib/apps/types'
import { FlatButton } from './spec'

// Variable edits are saved immediately but reach the running app only with the
// next deployment. Until then this bar stays on every tab of the environment, so
// a saved-but-not-live change is never forgotten after its toast fades.

export function PendingChanges({
  app,
  deploying,
  onReview,
  onDeploy,
}: {
  app: AppDetail
  /** Set while these changes are being deployed: they are no longer editable drafts. */
  deploying: { id: string } | null
  onReview?: () => void
  onDeploy: () => void
}) {
  const changes = app.pendingChanges ?? []
  if (changes.length === 0) return null
  return (
    <div className="mb-6 flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 border border-warning/25 bg-warning/[0.05] px-4 py-2 font-mono text-[13px]">
      <span className="size-[9px] shrink-0 bg-warning" aria-hidden />
      <span className="text-foreground">
        {deploying
          ? `Deploying ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} with ${deploying.id}`
          : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} not live in ${app.environment}`}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={changes.map(describeChange).join(', ')}>
        {changes.map(describeChange).join(' · ')}
      </span>
      {/* While deploying, the header carries the stage; the bar only says these changes are on their way. */}
      {deploying ? null : (
        <span className="flex items-center gap-1">
          {onReview && <FlatButton onClick={onReview}>Review</FlatButton>}
          <FlatButton variant="primary" onClick={onDeploy}>
            Deploy changes
          </FlatButton>
        </span>
      )}
    </div>
  )
}
