/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { ResourceChip } from '@/components/ResourceChip'
import { TimestampTooltip } from '@/components/TimestampTooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { getSandboxPublicId, getSandboxPublicIdLabel } from '@/lib/sandbox-identity'
import { getTemplateDisplayName } from '@/lib/template-display'
import { cn, formatDuration, getRelativeTimeString } from '@/lib/utils'
import { Sandbox } from '@boxlite-ai/api-client'
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

interface SandboxInfoPanelProps {
  sandbox: Sandbox
  getRegionName: (id: string) => string | undefined
}

export function SandboxInfoPanel({ sandbox }: SandboxInfoPanelProps) {
  const templateDisplayName = getTemplateDisplayName(sandbox.template)
  const publicBoxId = getSandboxPublicId(sandbox)

  return (
    <div className="flex flex-col">
      {sandbox.errorReason && (
        <div className="px-5 pt-4">
          <Alert variant={sandbox.recoverable ? 'warning' : 'destructive'}>
            <AlertCircle />
            <AlertDescription>{sandbox.errorReason}</AlertDescription>
          </Alert>
        </div>
      )}

      <InfoSection title="General">
        <InfoRow label="Box ID" className="-mr-2">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs">{getSandboxPublicIdLabel(sandbox)}</span>
            {publicBoxId && <CopyButton value={publicBoxId} tooltipText="Copy Box ID" size="icon-xs" />}
          </div>
        </InfoRow>
        <InfoRow label="Image" className="-mr-2">
          {sandbox.template ? (
            <div className="flex min-w-0 items-center gap-1">
              <div className="min-w-0 text-right">
                <div className="truncate text-sm">{templateDisplayName}</div>
                {templateDisplayName !== sandbox.template && (
                  <div className="truncate text-xs text-muted-foreground">{sandbox.template}</div>
                )}
              </div>
              <CopyButton value={sandbox.template} tooltipText="Copy" size="icon-xs" />
            </div>
          ) : (
            <span className="text-muted-foreground font-normal">—</span>
          )}
        </InfoRow>
      </InfoSection>

      <InfoSection title="Resources">
        <div className="flex flex-wrap gap-2 py-1">
          <ResourceChip resource="cpu" value={sandbox.cpu} />
          <ResourceChip resource="memory" value={sandbox.memory} />
          <ResourceChip resource="disk" value={sandbox.disk} />
        </div>
      </InfoSection>

      <InfoSection title="Lifecycle">
        <InfoRow label="Auto-stop">
          {sandbox.autoStopInterval ? (
            formatDuration(sandbox.autoStopInterval)
          ) : (
            <span className="text-muted-foreground font-normal">Disabled</span>
          )}
        </InfoRow>
        <InfoRow label="Auto-delete">
          {sandbox.autoDeleteInterval !== undefined && sandbox.autoDeleteInterval >= 0 ? (
            sandbox.autoDeleteInterval === 0 ? (
              'On stop'
            ) : (
              formatDuration(sandbox.autoDeleteInterval)
            )
          ) : (
            <span className="text-muted-foreground font-normal">Disabled</span>
          )}
        </InfoRow>
      </InfoSection>

      <InfoSection title="Timestamps">
        <InfoRow label="Created">
          <TimestampTooltip timestamp={sandbox.createdAt}>
            <span>{getRelativeTimeString(sandbox.createdAt).relativeTimeString}</span>
          </TimestampTooltip>
        </InfoRow>
        <InfoRow label="Last event">
          <TimestampTooltip timestamp={sandbox.updatedAt}>
            <span>{getRelativeTimeString(sandbox.updatedAt).relativeTimeString}</span>
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
