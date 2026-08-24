/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BRAND } from '@/components/ascii'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ModelsAggregatedUsage } from '@boxlite-ai/analytics-api-client'
import NumberFlow from '@number-flow/react'
import { motion } from 'framer-motion'
import React from 'react'

interface AggregatedUsageChartProps {
  data: ModelsAggregatedUsage | undefined
  isLoading: boolean
}

function formatSeconds(seconds: number): { value: number; suffix: string } {
  if (seconds < 60) return { value: Math.round(seconds * 10) / 10, suffix: ' s' }
  if (seconds < 3600) return { value: Math.round((seconds / 60) * 10) / 10, suffix: ' m' }
  return { value: Math.round((seconds / 3600) * 10) / 10, suffix: ' h' }
}

function formatGBSeconds(gbSeconds: number): { value: number; suffix: string } {
  if (gbSeconds < 3600) return { value: Math.round(gbSeconds * 10) / 10, suffix: ' GB-s' }
  return { value: Math.round((gbSeconds / 3600) * 10) / 10, suffix: ' GB-h' }
}

const transition = {
  type: 'spring',
  stiffness: 60,
  damping: 15,
  mass: 1,
} as const

const SEGMENTS = [
  { key: 'cpu' as const, label: 'CPU', color: 'bg-[hsl(var(--chart-1))]' },
  { key: 'ram' as const, label: 'RAM', color: 'bg-[hsl(var(--chart-2))]' },
  { key: 'disk' as const, label: 'Disk', color: 'bg-[hsl(var(--chart-3))]' },
]

export const UsageSummary: React.FC<AggregatedUsageChartProps> = ({ data, isLoading }) => {
  const totalPrice = data?.totalPrice ?? 0
  const boxCount = data?.boxCount ?? 0

  return (
    <div className="flex flex-col gap-6 px-[22px] py-5 sm:flex-row sm:gap-14">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Total Cost
        </div>
        <div className="relative">
          <div
            className={cn(
              'font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums',
              isLoading && 'invisible',
            )}
          >
            $
            <NumberFlow
              value={Math.round(totalPrice * 100) / 100}
              format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
            />
          </div>
          {isLoading && <Skeleton className="absolute inset-y-1 left-0 w-24" />}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Boxes
        </div>
        <div className="relative">
          <div
            className={cn(
              'font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums',
              isLoading && 'invisible',
            )}
          >
            <NumberFlow value={boxCount} />
          </div>
          {isLoading && <Skeleton className="absolute inset-y-1 left-0 w-14" />}
        </div>
      </div>
    </div>
  )
}

export const AggregatedUsageChart: React.FC<AggregatedUsageChartProps> = ({ data, isLoading }) => {
  const cpuSeconds = data?.totalCPUSeconds ?? 0
  const ramGBSeconds = data?.totalRAMGBSeconds ?? 0
  const diskGBSeconds = data?.totalDiskGBSeconds ?? 0

  const cpu = formatSeconds(cpuSeconds)
  const ram = formatGBSeconds(ramGBSeconds)
  const disk = formatGBSeconds(diskGBSeconds)

  return (
    <div className="overflow-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-3 -mr-px -mb-px">
        <StatItem label="CPU" suffix={cpu.suffix} isLoading={isLoading}>
          <NumberFlow value={cpu.value} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} />
        </StatItem>
        <StatItem label="RAM" suffix={ram.suffix} isLoading={isLoading}>
          <NumberFlow value={ram.value} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} />
        </StatItem>
        <StatItem label="Disk" suffix={disk.suffix} isLoading={isLoading}>
          <NumberFlow value={disk.value} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} />
        </StatItem>
      </div>
    </div>
  )
}

function StatItem({
  label,
  suffix,
  children,
  isLoading,
}: {
  label: string
  suffix?: string
  children: React.ReactNode
  isLoading?: boolean
}) {
  return (
    <div className="flex items-center gap-2 border-b border-r border-border px-[22px] py-3 sm:block sm:py-4">
      <p className="font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">{label}</p>
      <div className="relative">
        <p className={cn('font-mono text-[18px] font-semibold leading-none tabular-nums', isLoading && 'invisible')}>
          {children}
          {suffix && (
            <span className="text-[10px] font-normal uppercase tracking-[0.5px] text-muted-foreground">{suffix}</span>
          )}
        </p>
        {isLoading && <Skeleton className="absolute top-1 h-5 w-16" />}
      </div>
    </div>
  )
}

export const ResourceUsageBreakdown: React.FC<{ data: ModelsAggregatedUsage | undefined }> = ({ data }) => {
  const cpuSeconds = data?.totalCPUSeconds ?? 0
  const ramGBSeconds = data?.totalRAMGBSeconds ?? 0
  const diskGBSeconds = data?.totalDiskGBSeconds ?? 0

  const segmentValues = {
    cpu: cpuSeconds,
    ram: ramGBSeconds,
    disk: diskGBSeconds,
  }
  const total = cpuSeconds + ramGBSeconds + diskGBSeconds

  return (
    <div className="flex flex-col gap-4 px-[22px] py-5">
      <p className="font-mono text-[11px] uppercase tracking-[1.5px] text-foreground">
        <span style={{ color: BRAND }}>▸</span> Resource Breakdown
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex h-1.5 w-full overflow-clip bg-brand/15">
          {total === 0
            ? null
            : SEGMENTS.map(({ key, color }) => {
                const value = segmentValues[key]
                if (value === 0) return null
                const pct = (value / total) * 100
                return (
                  <motion.div
                    key={key}
                    className={cn('h-full', color)}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={transition}
                  />
                )
              })}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {SEGMENTS.map(({ key, label, color }) => (
            <div key={key} className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
              <div className={cn('size-2', color)} />
              <span className="uppercase tracking-[0.5px] text-muted-foreground">
                {label} {total > 0 ? `${Math.round((segmentValues[key] / total) * 100)}%` : '0%'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
