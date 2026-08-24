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
import { useOwnerUsageSeriesQuery } from '@/hooks/queries/billingQueries'
import { UsageFundingBucket } from '@/billing-api'
import { formatMoney } from '@/lib/utils'
import { subDays, subHours } from 'date-fns'
import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'

/**
 * Cost over time, split by who funded it: the plan's quota first, the wallet
 * after — the billing service's own settlement record, so a bucket here is
 * money that actually moved (or an honest zero), never an estimate. Chart is
 * the last 30 days by day; list is the last 24 hours by hour, fetched only
 * when opened.
 */

const chartConfig = {
  quota: { label: 'Quota-covered', color: 'hsl(var(--brand))' },
  wallet: { label: 'From wallet', color: 'hsl(var(--warning))' },
} satisfies ChartConfig

type Point = { time: string; quota: number; wallet: number; total: number }

function toPoints(buckets: UsageFundingBucket[] | undefined): Point[] {
  return (buckets ?? []).map((bucket) => {
    const quota = bucket.quotaCoveredCents / 100
    const wallet = bucket.fromWalletCents / 100
    return { time: bucket.from.toISOString(), quota, wallet, total: quota + wallet }
  })
}

const shortDay = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const shortHour = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const ROW = 'grid grid-cols-[1fr_110px_110px_110px] items-center gap-x-4'

export function CostOverTime() {
  const [view, setView] = useState<'chart' | 'list'>('chart')
  // Pinned once per mount: a window recomputed every render would churn the
  // query key. The windows are the PRD's own — daily for the chart, the last
  // 24 hours for the list.
  const [windows] = useState(() => {
    const now = new Date()
    return { chartFrom: subDays(now, 30), listFrom: subHours(now, 24), to: now }
  })

  const daily = useOwnerUsageSeriesQuery('day', windows.chartFrom, windows.to)
  const hourly = useOwnerUsageSeriesQuery('hour', windows.listFrom, windows.to, view === 'list')

  const points = useMemo(() => toPoints(daily.data), [daily.data])
  const hours = useMemo(() => toPoints(hourly.data), [hourly.data])
  const active = view === 'chart' ? daily : hourly
  // The header total describes what is on screen: 30 days in chart view, the
  // last 24 hours in list view.
  const activePoints = view === 'chart' ? points : hours
  const total = useMemo(() => activePoints.reduce((sum, p) => sum + p.total, 0), [activePoints])

  return (
    <section>
      <SectionTitle
        title="Cost Over Time"
        count={total > 0 ? formatMoney(total) : undefined}
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
        {active.isError ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                <AlertCircle />
              </EmptyMedia>
              <EmptyTitle className="text-destructive">Failed to load cost data</EmptyTitle>
              <EmptyDescription>Something went wrong while fetching the funding series.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm" onClick={() => active.refetch()}>
                <RefreshCw />
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        ) : active.isLoading ? (
          <div className="flex h-[180px] items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : view === 'chart' && total === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BarChart3 />
              </EmptyMedia>
              <EmptyTitle>No cost yet</EmptyTitle>
              <EmptyDescription>Settled cost appears here once boxes run — quota-covered first.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === 'chart' ? (
          <div className="px-[22px] py-5">
            <div className="mb-3 flex flex-wrap items-center gap-4">
              {Object.entries(chartConfig).map(([key, { label, color }]) => (
                <span key={key} className="inline-flex items-center gap-1.5 font-mono text-[12px]">
                  <span className="size-[9px] shrink-0" style={{ background: color }} />
                  <span className="text-foreground">{label}</span>
                </span>
              ))}
            </div>
            <ChartContainer config={chartConfig} className="aspect-auto h-[180px] w-full">
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
                  tickFormatter={shortDay}
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
                        `${shortDay(String(label))}: ${formatMoney(
                          payload.reduce((acc, curr) => acc + (curr.value as number), 0),
                        )}`
                      }
                    />
                  }
                />
                <Area
                  dataKey="quota"
                  type="monotoneX"
                  stackId="a"
                  stroke="var(--color-quota)"
                  fill="url(#cost-quota)"
                />
                <Area
                  dataKey="wallet"
                  type="monotoneX"
                  stackId="a"
                  stroke="var(--color-wallet)"
                  fill="url(#cost-wallet)"
                />
              </AreaChart>
            </ChartContainer>
          </div>
        ) : (
          <div className="max-h-[240px] overflow-y-auto px-[22px] py-4">
            <div
              className={`${ROW} border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`}
            >
              <span>Hour</span>
              <span className="text-right">Quota</span>
              <span className="text-right">Wallet</span>
              <span className="text-right">Total</span>
            </div>
            {hours.map((p) => (
              <div
                key={p.time}
                className={`${ROW} border-b border-border/40 py-[11px] font-mono text-[12px] transition-colors hover:bg-muted/30`}
              >
                <span className="text-foreground">{shortHour(p.time)}</span>
                <span
                  className={`text-right tabular-nums ${p.quota > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {p.quota > 0 ? formatMoney(p.quota, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—'}
                </span>
                <span className={`text-right tabular-nums ${p.wallet > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                  {p.wallet > 0 ? formatMoney(p.wallet, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—'}
                </span>
                <span className="text-right tabular-nums text-foreground">
                  {formatMoney(p.total, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                </span>
              </div>
            ))}
            <div className="pt-2">
              <PanelNote>Last 24 hours · per-hour granularity</PanelNote>
            </div>
          </div>
        )}
      </Panel>
    </section>
  )
}
