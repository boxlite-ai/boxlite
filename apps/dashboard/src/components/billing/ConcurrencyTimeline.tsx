/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { Button } from '@/components/ui/button'
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { AlertCircle, RefreshCw } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { useOrganizationConcurrencyQuery } from '@/hooks/queries/useOrganizationConcurrencyQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'

const chartConfig = {
  runningBoxes: { label: 'Concurrent boxes', color: 'hsl(var(--brand))' },
} satisfies ChartConfig

const shortHour = (value: number) =>
  new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

export function ConcurrencyTimeline() {
  const { selectedOrganization } = useSelectedOrganization()
  const query = useOrganizationConcurrencyQuery({ organizationId: selectedOrganization?.id, hours: 24 })
  const points = useMemo(
    () =>
      (query.data?.points ?? []).map((point) => ({
        time: new Date(point.observedAt).getTime(),
        runningBoxes: point.runningBoxes,
      })),
    [query.data?.points],
  )
  const limit = query.data?.limit ?? null
  const highest = Math.max(limit ?? 0, ...points.map((point) => point.runningBoxes), 1)
  const axisMaximum = Math.max(30, Math.ceil(highest / 30) * 30)

  return (
    <section>
      <SectionTitle
        title="Concurrency Timeline"
        count={query.data ? `${query.data.current} / ${query.data.limit ?? 'Unlimited'}` : undefined}
      />
      <Panel>
        {query.isError ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                <AlertCircle />
              </EmptyMedia>
              <EmptyTitle className="text-destructive">Failed to load concurrency</EmptyTitle>
              <EmptyDescription>Something went wrong while fetching the concurrency timeline.</EmptyDescription>
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
            <div className="mb-3 flex items-center gap-4 font-mono text-[12px]">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-[9px] bg-brand" />
                <span>Concurrent boxes</span>
              </span>
              {limit != null && <span className="text-muted-foreground">limit = {limit}</span>}
            </div>
            <ChartContainer config={chartConfig} className="aspect-auto h-[180px] w-full">
              <AreaChart data={points}>
                <defs>
                  <linearGradient id="concurrency-running" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-runningBoxes)" stopOpacity={0.65} />
                    <stop offset="95%" stopColor="var(--color-runningBoxes)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={shortHour}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  domain={[0, axisMaximum]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  tickCount={5}
                  allowDecimals={false}
                  width={36}
                  tick={{ fontSize: 10 }}
                />
                {limit != null && (
                  <ReferenceLine
                    y={limit}
                    stroke="hsl(var(--warning))"
                    strokeDasharray="4 4"
                    ifOverflow="extendDomain"
                  />
                )}
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      labelFormatter={(label) =>
                        `${shortHour(Number(label))} · ${new Date(Number(label)).toLocaleDateString()}`
                      }
                    />
                  }
                />
                <Area
                  dataKey="runningBoxes"
                  type="stepAfter"
                  stroke="var(--color-runningBoxes)"
                  fill="url(#concurrency-running)"
                />
              </AreaChart>
            </ChartContainer>
            <div className="pt-3">
              <PanelNote>
                Last 24 hours · creates, starts, and auto-resumes above the effective entitlement are rejected with HTTP
                429
              </PanelNote>
            </div>
          </div>
        )}
      </Panel>
    </section>
  )
}
