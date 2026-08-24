/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BRAND, Panel, SectionTitle } from '@/components/ascii'
import { Button } from '@/components/ui/button'
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { AlertCircle, RefreshCw } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { useOwnerConcurrencyQuery, useOwnerPlanQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { planConcurrencyLimit } from '@/lib/plan-concurrency'
import { GetOrganizationUsageConcurrencyGranularityEnum } from '@boxlite-ai/api-client'
import { subDays } from 'date-fns'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts'

const chartConfig = {
  runningBoxes: { label: 'Concurrent boxes', color: 'hsl(var(--brand))' },
} satisfies ChartConfig

type TimelinePoint = { time: number; runningBoxes: number }

const shortDay = (value: number) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function concurrencyAxisMaximum(points: TimelinePoint[]): number {
  const highest = Math.max(...points.map((point) => point.runningBoxes), 1)
  const interval = highest <= 10 ? 2 : highest <= 50 ? 10 : highest <= 200 ? 20 : 100
  return Math.max(interval, (Math.floor(highest / interval) + 1) * interval)
}

export function ConcurrencyTimeline() {
  const [window] = useState(() => {
    const to = new Date()
    return { from: subDays(to, 30), to }
  })
  const query = useOwnerConcurrencyQuery(GetOrganizationUsageConcurrencyGranularityEnum.DAY, window.from, window.to)
  const { data: organizationPlan } = useOwnerPlanQuery()
  const { data: plans } = usePlansQuery()
  const limit = planConcurrencyLimit(organizationPlan, plans)
  const points = useMemo<TimelinePoint[]>(
    () =>
      (query.data?.points ?? []).map((point) => ({
        time: new Date(point.observedAt).getTime(),
        runningBoxes: point.runningBoxes,
      })),
    [query.data?.points],
  )
  const axisMaximum = concurrencyAxisMaximum(points)
  const isLimitInChartRange = limit != null && limit <= axisMaximum

  return (
    <section>
      <SectionTitle
        title="Concurrency Timeline"
        right={
          limit != null ? (
            <span className="font-mono text-[10px] text-muted-foreground">limit = {limit}</span>
          ) : undefined
        }
      />
      <Panel>
        {query.isError ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                <AlertCircle />
              </EmptyMedia>
              <EmptyTitle className="text-destructive">Failed to load concurrency</EmptyTitle>
              <EmptyDescription>Usage periods could not be read for this timeline.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
                <RefreshCw />
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        ) : query.isLoading ? (
          <div className="flex h-[180px] items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : (
          <div className="px-[22px] py-5">
            <ChartContainer config={chartConfig} className="aspect-auto h-[140px] w-full">
              <LineChart data={points} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  minTickGap={48}
                  tickFormatter={shortDay}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  domain={[0, axisMaximum]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  tickCount={5}
                  allowDecimals={false}
                  width={36}
                  tick={{ fontSize: 10 }}
                />
                {isLimitInChartRange && (
                  <ReferenceLine
                    y={limit}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="6 4"
                  />
                )}
                <ChartTooltip
                  cursor={{ stroke: 'hsl(var(--border))', strokeDasharray: '3 3' }}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
                      formatter={(value) => (
                        <div className="flex min-w-[130px] items-center justify-between gap-4">
                          <span className="text-muted-foreground">Concurrent boxes</span>
                          <span className="font-mono font-medium tabular-nums text-foreground">{Number(value)}</span>
                        </div>
                      )}
                    />
                  }
                />
                <Line
                  dataKey="runningBoxes"
                  type="monotoneX"
                  stroke="var(--color-runningBoxes)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--color-runningBoxes)', strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> Daily snapshots from compute-bearing usage periods · the plan
              limit is informational; excess starts are not rejected yet
            </p>
          </div>
        )}
      </Panel>
    </section>
  )
}
