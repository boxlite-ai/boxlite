/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { AlertCircle, BarChart3, RefreshCw } from '@/components/ui/icon'
import { AnalyticsUsageParams, useUsageChart } from '@/hooks/queries/useAnalyticsUsage'
import { formatMoney } from '@/lib/utils'
import { ModelsUsageChartPoint } from '@boxlite-ai/analytics-api-client'
import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'

/**
 * Priced usage over time, split by resource.
 *
 * The design splits cost into quota-covered vs wallet-drawn; no quota concept
 * exists server-side, so the split here is CPU / RAM / disk — the dimensions
 * `/usage/chart` actually prices.
 */

const chartConfig = {
  cpuPrice: { label: 'CPU', color: 'hsl(var(--chart-1))' },
  ramPrice: { label: 'RAM', color: 'hsl(var(--chart-2))' },
  diskPrice: { label: 'Disk', color: 'hsl(var(--chart-3))' },
} satisfies ChartConfig

type Point = {
  time: string
  cpuPrice: number
  ramPrice: number
  diskPrice: number
  total: number
}

function toPoints(raw: ModelsUsageChartPoint[] | undefined): Point[] {
  return (raw ?? []).map((p) => {
    const cpuPrice = p.cpuPrice ?? 0
    const ramPrice = p.ramPrice ?? 0
    const diskPrice = p.diskPrice ?? 0
    return { time: p.time ?? '', cpuPrice, ramPrice, diskPrice, total: cpuPrice + ramPrice + diskPrice }
  })
}

const shortTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const ROW = 'grid grid-cols-[1fr_90px_90px_90px_100px] items-center gap-x-4'

export function CostOverTime({ params }: { params: AnalyticsUsageParams }) {
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const { data, isLoading, isError, refetch } = useUsageChart(params)
  const points = useMemo(() => toPoints(data), [data])
  const total = useMemo(() => points.reduce((sum, p) => sum + p.total, 0), [points])

  return (
    <section>
      <SectionTitle
        title="Cost Over Time"
        count={points.length ? formatMoney(total) : undefined}
        right={
          <div className="flex items-center border border-border">
            {(['chart', 'list'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setView(mode)}
                className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-[1px] transition-colors ${
                  view === mode ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        }
      />
      <Panel>
        {isError ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                <AlertCircle />
              </EmptyMedia>
              <EmptyTitle className="text-destructive">Failed to load cost data</EmptyTitle>
              <EmptyDescription>Something went wrong while fetching the usage series.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                <RefreshCw />
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        ) : isLoading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : !points.length ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BarChart3 />
              </EmptyMedia>
              <EmptyTitle>No cost data yet</EmptyTitle>
              <EmptyDescription>Cost appears here once boxes run in the selected time range.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === 'chart' ? (
          <div className="px-[22px] py-5">
            <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
              <AreaChart data={points}>
                <defs>
                  {Object.keys(chartConfig).map((key) => (
                    <linearGradient key={key} id={`cost-${key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.7} />
                      <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={shortTime}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  tickCount={4}
                  width={52}
                  tickFormatter={(value) => formatMoney(value)}
                  tick={{ fontSize: 10 }}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      labelFormatter={(label, payload) =>
                        `${shortTime(String(label))}: ${formatMoney(
                          payload.reduce((acc, curr) => acc + (curr.value as number), 0),
                        )}`
                      }
                    />
                  }
                />
                <Area
                  dataKey="cpuPrice"
                  type="monotoneX"
                  stackId="a"
                  stroke="var(--color-cpuPrice)"
                  fill="url(#cost-cpuPrice)"
                />
                <Area
                  dataKey="ramPrice"
                  type="monotoneX"
                  stackId="a"
                  stroke="var(--color-ramPrice)"
                  fill="url(#cost-ramPrice)"
                />
                <Area
                  dataKey="diskPrice"
                  type="monotoneX"
                  stackId="a"
                  stroke="var(--color-diskPrice)"
                  fill="url(#cost-diskPrice)"
                />
              </AreaChart>
            </ChartContainer>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {Object.entries(chartConfig).map(([key, { label, color }]) => (
                <span key={key} className="inline-flex items-center gap-1.5 font-mono text-[12px]">
                  <span className="size-[9px] shrink-0" style={{ background: color }} />
                  <span className="text-foreground">{label}</span>
                </span>
              ))}
            </div>
            <PanelNote>Priced per resource, over the selected range</PanelNote>
          </div>
        ) : (
          <div className="px-[22px] py-4">
            <div
              className={`${ROW} border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`}
            >
              <span>Time</span>
              <span className="text-right">CPU</span>
              <span className="text-right">RAM</span>
              <span className="text-right">Disk</span>
              <span className="text-right">Total</span>
            </div>
            {points.map((p) => (
              <div
                key={p.time}
                className={`${ROW} border-b border-border/40 py-[11px] font-mono text-[12px] transition-colors hover:bg-muted/30`}
              >
                <span className="text-foreground">{shortTime(p.time)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{formatMoney(p.cpuPrice)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{formatMoney(p.ramPrice)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{formatMoney(p.diskPrice)}</span>
                <span className="text-right tabular-nums text-foreground">{formatMoney(p.total)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </section>
  )
}
