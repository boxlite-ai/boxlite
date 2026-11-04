/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, SectionTitle } from '@/components/ascii'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import type { AppMetrics } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'

// The last 24 hours of an app, drawn the way Billing draws cost over time: headline numbers on
// top, one hourly area chart below that switches between what visitors sent, how fast the app
// answered, and who was signed in. From the app proxy's access log and the sign-in sessions.

type View = 'requests' | 'latency' | 'users'

const CHARTS: Record<View, { label: string; config: ChartConfig }> = {
  requests: {
    label: 'Requests',
    config: {
      requests: { label: 'Requests', color: 'hsl(var(--brand))' },
      errors: { label: 'Errors (5xx)', color: 'hsl(var(--destructive))' },
    },
  },
  latency: { label: 'Latency', config: { p95: { label: 'p95 latency', color: 'hsl(var(--brand))' } } },
  users: { label: 'Users', config: { users: { label: 'Signed-in users', color: 'hsl(var(--brand))' } } },
}

const sum = (data: number[]) => data.reduce((a, b) => a + b, 0)
const lastMeasured = (data: (number | null)[]) => [...data].reverse().find((v) => v !== null) ?? null

/** Hour `i` of 24 ending now, as a clock time. */
function hourOf(i: number, count: number): string {
  const d = new Date(Date.now() - (count - 1 - i) * 3_600_000)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/:\d\d$/, ':00')
}

export function TrafficPanel({ metrics: m }: { metrics: AppMetrics }) {
  const [view, setView] = useState<View>('requests')
  const total = sum(m.requests)
  const errors = sum(m.errors)
  const errorRate = total ? (errors / total) * 100 : 0
  const p95 = lastMeasured(m.p95Ms)
  const users = m.activeUsers.at(-1) ?? 0
  const delta =
    m.previousRequests && m.previousRequests > 0
      ? Math.round(((total - m.previousRequests) / m.previousRequests) * 100)
      : null

  const points = useMemo(
    () =>
      m.requests.map((requests, i) => ({
        hour: hourOf(i, m.requests.length),
        requests,
        errors: m.errors[i] ?? 0,
        p95: m.p95Ms[i],
        users: m.activeUsers[i] ?? 0,
      })),
    [m],
  )

  const headline: { label: string; value: string; unit?: string; note?: string; bad?: boolean }[] = [
    {
      label: 'Requests',
      value: total.toLocaleString('en-US'),
      note: delta === null ? undefined : `${delta >= 0 ? '+' : ''}${delta}% vs the 24 h before`,
    },
    {
      label: 'Errors (5xx)',
      value: errors.toLocaleString('en-US'),
      note: total ? `${errorRate.toFixed(errorRate < 10 ? 2 : 1)}% of requests` : undefined,
      bad: errorRate > 1,
    },
    {
      label: 'p95 latency',
      value: p95 === null ? '—' : String(p95),
      unit: p95 === null ? undefined : 'ms',
      note: p95 === null ? 'No requests yet' : 'last hour with traffic',
      bad: p95 !== null && p95 > 500,
    },
    { label: 'Signed-in users', value: String(users), note: 'with a session now' },
  ]

  const chart = CHARTS[view]
  return (
    <section>
      <SectionTitle
        title="Last 24 hours"
        right={
          <div className="flex items-center bg-card">
            {(Object.keys(CHARTS) as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  '-ml-px border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[1px] transition-colors first:ml-0',
                  view === v
                    ? 'relative z-10 border-foreground/45 bg-background font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {CHARTS[v].label}
              </button>
            ))}
          </div>
        }
      />
      <Panel>
        <div className="grid grid-cols-2 border-b border-border xl:grid-cols-4">
          {headline.map((h, i) => (
            <div
              key={h.label}
              className={cn(
                'flex flex-col gap-1 px-[22px] py-4 font-mono',
                i > 0 && 'xl:border-l xl:border-border',
                i % 2 === 1 && 'border-l border-border',
              )}
            >
              <span className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{h.label}</span>
              <span
                className={cn(
                  'text-[24px] font-semibold tabular-nums tracking-tight',
                  h.bad ? 'text-destructive' : 'text-foreground',
                )}
              >
                {h.value}
                {h.unit && <span className="ml-1 text-[12px] font-normal text-muted-foreground">{h.unit}</span>}
              </span>
              <span className="h-[16px] truncate text-[11px] text-muted-foreground">{h.note ?? ''}</span>
            </div>
          ))}
        </div>
        <div className="px-[22px] py-5">
          <div className="mb-3 flex flex-wrap items-center gap-4">
            {Object.entries(chart.config).map(([key, { label, color }]) => (
              <span key={key} className="inline-flex items-center gap-1.5 font-mono text-[12px]">
                <span className="size-[9px] shrink-0" style={{ background: color }} />
                <span className="text-foreground">{label}</span>
              </span>
            ))}
          </div>
          <ChartContainer config={chart.config} className="aspect-auto h-[180px] w-full">
            <AreaChart data={points}>
              <defs>
                {Object.keys(chart.config).map((key) => (
                  <linearGradient key={key} id={`traffic-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.7} />
                    <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="hour"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                tickCount={4}
                width={44}
                allowDecimals={false}
                tickFormatter={(v) => (view === 'latency' ? `${v} ms` : String(v))}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              {Object.keys(chart.config).map((key) => (
                <Area
                  key={key}
                  dataKey={key}
                  type="monotoneX"
                  connectNulls={view === 'latency'}
                  stroke={`var(--color-${key})`}
                  fill={`url(#traffic-${key})`}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        </div>
      </Panel>
    </section>
  )
}
