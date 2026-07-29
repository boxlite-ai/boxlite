/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import type { OrganizationUsageOverview } from '@boxlite-ai/api-client'
import type { ReactNode } from 'react'
import QuotaLine from './QuotaLine'
import { Skeleton } from './ui/skeleton'

/**
 * Current consumption against each organization ceiling.
 *
 * Upstream renders one of these per (region, sandbox class) and takes a
 * `RegionUsageOverview`. BoxLite quotas are a single org-wide row, so this takes
 * the flat overview and shows all six ceilings — including the two upstream has
 * no concept of, concurrent boxes and volumes. Omitting them would show four of
 * six limits and read as "you have headroom" when a box create is about to be
 * refused for exceeding the box count.
 */
export function UsageOverview({
  usageOverview,
  className,
}: {
  usageOverview: OrganizationUsageOverview
  className?: string
}) {
  return (
    <div className={cn('grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', className)}>
      <ResourceUsageItem
        label="Compute"
        value={<UsageValue current={usageOverview.currentCpuUsage} total={usageOverview.totalCpuQuota} unit="vCPU" />}
      >
        <QuotaLine current={usageOverview.currentCpuUsage} total={usageOverview.totalCpuQuota} />
      </ResourceUsageItem>
      <ResourceUsageItem
        label="Memory"
        value={
          <UsageValue current={usageOverview.currentMemoryUsage} total={usageOverview.totalMemoryQuota} unit="GiB" />
        }
      >
        <QuotaLine current={usageOverview.currentMemoryUsage} total={usageOverview.totalMemoryQuota} />
      </ResourceUsageItem>
      <ResourceUsageItem
        label="Storage"
        value={<UsageValue current={usageOverview.currentDiskUsage} total={usageOverview.totalDiskQuota} unit="GiB" />}
      >
        <QuotaLine current={usageOverview.currentDiskUsage} total={usageOverview.totalDiskQuota} />
      </ResourceUsageItem>
      <ResourceUsageItem
        label="GPU"
        value={
          <UsageValue
            current={usageOverview.currentGpuUsage}
            total={usageOverview.totalGpuQuota}
            unit="GPU"
            zeroQuotaValue={<span className="text-xs text-muted-foreground text-nowrap">Not enabled</span>}
          />
        }
      >
        <QuotaLine current={usageOverview.currentGpuUsage} total={usageOverview.totalGpuQuota} />
      </ResourceUsageItem>
      <ResourceUsageItem
        label="Running boxes"
        value={
          <UsageValue current={usageOverview.currentBoxUsage} total={usageOverview.maxConcurrentBoxes} unit="boxes" />
        }
      >
        <QuotaLine current={usageOverview.currentBoxUsage} total={usageOverview.maxConcurrentBoxes} />
      </ResourceUsageItem>
      <ResourceUsageItem
        label="Volumes"
        value={
          <UsageValue current={usageOverview.currentVolumeUsage} total={usageOverview.maxVolumes} unit="volumes" />
        }
      >
        <QuotaLine current={usageOverview.currentVolumeUsage} total={usageOverview.maxVolumes} />
      </ResourceUsageItem>
    </div>
  )
}

function formatUsageValue(value: number) {
  const truncated = Math.trunc(value * 10) / 10

  if (Number.isInteger(truncated)) {
    return String(truncated)
  }

  return truncated.toFixed(1)
}

function UsageValue({
  current,
  total,
  unit,
  zeroQuotaValue,
}: {
  current: number
  total: number
  unit: string
  zeroQuotaValue?: ReactNode
}) {
  if (total > 0 || current > 0) {
    return (
      <span className="text-xs text-muted-foreground text-nowrap">
        {formatUsageValue(current)} / {formatUsageValue(total)} {unit}
      </span>
    )
  }

  return zeroQuotaValue ?? <span className="text-xs text-muted-foreground text-nowrap">0 / 0 {unit}</span>
}

function ResourceUsageItem({
  label,
  value,
  className,
  children,
}: {
  label: string
  value: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {value}
      </div>
      {children}
    </div>
  )
}

export function UsageOverviewSkeleton() {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  )
}
