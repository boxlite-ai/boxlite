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
import { cn, formatDuration, getRelativeTimeString } from '@/lib/utils'
import { Box } from '@boxlite-ai/api-client'
import { AlertCircle } from 'lucide-react'
import React from 'react'

export function InfoSection({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('px-5 py-4 border-b border-border last:border-b-0', className)}>
      <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2">{title}</p>
      {children}
    </div>
  )
}

export function InfoRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-1', className)}>
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="min-w-0 text-sm text-right">{children}</div>
    </div>
  )
}

interface BoxInfoPanelProps {
  box: Box
  getRegionName: (id: string) => string | undefined
}

export function BoxInfoPanel({ box }: BoxInfoPanelProps) {
  const publicBoxId = getBoxPublicId(box)

  return (
    <div className="flex flex-col">
      {box.errorReason && (
        <div className="px-5 pt-4">
          <Alert variant={box.recoverable ? 'warning' : 'destructive'}>
            <AlertCircle />
            <AlertDescription>{box.errorReason}</AlertDescription>
          </Alert>
        </div>
      )}

      <InfoSection title="General">
        <InfoRow label="Box ID" className="-mr-2">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs">{getBoxPublicIdLabel(box)}</span>
            {publicBoxId && <CopyButton value={publicBoxId} tooltipText="Copy Box ID" size="icon-xs" />}
          </div>
        </InfoRow>
      </InfoSection>

      <InfoSection title="Resources">
        <div className="flex flex-wrap gap-2 py-1">
          <ResourceChip resource="cpu" value={box.cpu} />
          <ResourceChip resource="memory" value={box.memory} />
          <ResourceChip resource="disk" value={box.disk} />
        </div>
      </InfoSection>

      <InfoSection title="Lifecycle">
        <InfoRow label="Auto-stop">
          {box.autoStopInterval ? (
            formatDuration(box.autoStopInterval)
          ) : (
            <span className="text-muted-foreground font-normal">Disabled</span>
          )}
        </InfoRow>
        <InfoRow label="Auto-delete">
          {box.autoDeleteInterval !== undefined && box.autoDeleteInterval >= 0 ? (
            box.autoDeleteInterval === 0 ? (
              'On stop'
            ) : (
              formatDuration(box.autoDeleteInterval)
            )
          ) : (
            <span className="text-muted-foreground font-normal">Disabled</span>
          )}
        </InfoRow>
      </InfoSection>

      <InfoSection title="Timestamps">
        <InfoRow label="Created">
          <TimestampTooltip timestamp={box.createdAt}>
            <span>{getRelativeTimeString(box.createdAt).relativeTimeString}</span>
          </TimestampTooltip>
        </InfoRow>
        <InfoRow label="Last event">
          <TimestampTooltip timestamp={box.updatedAt}>
            <span>{getRelativeTimeString(box.updatedAt).relativeTimeString}</span>
          </TimestampTooltip>
        </InfoRow>
      </InfoSection>
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
