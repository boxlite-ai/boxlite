/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { ResourceChip } from '@/components/ResourceChip'
import { TimestampTooltip } from '@/components/TimestampTooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { getBoxPublicId, getBoxPublicIdLabel } from '@/lib/box-identity'
import { getRelativeTimeString } from '@/lib/utils'
import { Box } from '@boxlite-ai/api-client'
import { AlertCircle } from '@/components/ui/icon'
import React from 'react'

interface BoxInfoPanelProps {
  box: Box
  getRegionName: (id: string) => string | undefined
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-display text-xs font-bold text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate text-sm">{children}</div>
    </div>
  )
}

export function BoxInfoPanel({ box, getRegionName }: BoxInfoPanelProps) {
  const publicBoxId = getBoxPublicId(box)
  const region = getRegionName(box.target) ?? box.target
  const labelEntries = Object.entries(box.labels ?? {})

  return (
    <div className="rounded-xl border border-border/60 bg-card shadow-card">
      {box.errorReason && (
        <div className="px-5 pt-4">
          <Alert variant={box.recoverable ? 'warning' : 'destructive'}>
            <AlertCircle />
            <AlertDescription>{box.errorReason}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="space-y-5 px-5 py-4">
        <MetaCell label="Image">
          {box.image ? (
            <span className="block truncate" title={box.image}>
              {box.image}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </MetaCell>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
          <MetaCell label="Box ID">
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate">{getBoxPublicIdLabel(box)}</span>
              {publicBoxId && <CopyButton value={publicBoxId} tooltipText="Copy Box ID" size="icon-xs" />}
            </div>
          </MetaCell>
          <MetaCell label="Region">
            {region ? <span className="uppercase">{region}</span> : <span className="text-muted-foreground">—</span>}
          </MetaCell>
          <MetaCell label="Resources">
            <div className="flex flex-wrap gap-1.5">
              <ResourceChip resource="cpu" value={box.cpu} />
              <ResourceChip resource="memory" value={box.memory} />
              <ResourceChip resource="disk" value={box.disk} />
            </div>
          </MetaCell>
          <MetaCell label="Created">
            <TimestampTooltip timestamp={box.createdAt}>
              <span>{getRelativeTimeString(box.createdAt).relativeTimeString}</span>
            </TimestampTooltip>
          </MetaCell>
          <MetaCell label="Last event">
            <TimestampTooltip timestamp={box.updatedAt}>
              <span>{getRelativeTimeString(box.updatedAt).relativeTimeString}</span>
            </TimestampTooltip>
          </MetaCell>
        </div>
      </div>

      {labelEntries.length > 0 && (
        <div className="border-t border-border px-5 py-4">
          <p className="mb-2 text-xs text-muted-foreground">Labels</p>
          <div className="flex flex-wrap gap-1.5">
            {labelEntries.map(([key, value]) => (
              <span
                key={key}
                className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
              >
                {key}={value}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function InfoPanelSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="px-5 py-4 border-b border-border">
        <Skeleton className="h-2.5 w-16 mb-3" />
        <div className="space-y-3">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
      <div className="px-5 py-4 border-b border-border">
        <Skeleton className="h-2.5 w-20 mb-3" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </div>
      <div className="px-5 py-4 border-b border-border">
        <Skeleton className="h-2.5 w-18 mb-3" />
        <div className="space-y-3">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-4 w-22" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      </div>
      <div className="px-5 py-4">
        <Skeleton className="h-2.5 w-24 mb-3" />
        <div className="space-y-3">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </div>
    </div>
  )
}
