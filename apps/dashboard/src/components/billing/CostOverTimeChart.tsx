/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// TEMP(preview): Cost Over Time — chart + list view toggle.
// Mock: quota covers days 1-18, wallet covers days 19-30 (left-right distribution).

import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BRAND, SectionTitle } from './ascii'

const LIMIT = 100
const QUOTA_DAILY = 13.89 // $250 / 18 days until exhausted

// Generate daily data: quota covers first 18 days, wallet covers remaining
function generateDailyData() {
  const days = 30
  const data = []
  for (let i = 0; i < days; i++) {
    const date = `Jul ${i + 1}`
    const baseUsage = 10 + Math.sin(i * 0.3) * 3 + (i % 7 < 5 ? 2 : 0)
    // Quota exhausted after day 18
    const quotaExhausted = i >= 18
    const quotaCovered = quotaExhausted ? 0 : Math.min(baseUsage, QUOTA_DAILY)
    const fromWallet = quotaExhausted ? baseUsage : 0
    const concurrency = 50 + Math.round(Math.sin(i * 0.3) * 20 + (i >= 22 && i <= 25 ? 35 : 0))

    data.push({ date, quotaCovered: +quotaCovered.toFixed(2), fromWallet: +fromWallet.toFixed(2), concurrency: Math.min(concurrency, 110) })
  }
  return data
}

// Generate hourly data for the list view (last 24 hours)
function generateHourlyData() {
  const hours = []
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`
    const base = 0.4 + Math.sin(h * 0.5) * 0.15 + (h >= 9 && h <= 18 ? 0.3 : 0)
    // Simulate: quota still covering (we're mid-cycle in this demo)
    hours.push({ hour: label, quota: +base.toFixed(3), wallet: 0 })
  }
  // Last few hours: quota exhausted, wallet kicks in
  for (let h = 20; h < 24; h++) {
    hours[h].quota = 0
    hours[h].wallet = +(0.5 + Math.random() * 0.3).toFixed(3)
  }
  return hours
}

const COLOR_QUOTA = BRAND
const COLOR_WALLET = 'hsl(38 92% 50%)'
const COLOR_LINE = BRAND
const COLOR_LIMIT = 'hsl(var(--muted-foreground))'

export function CostOverTimeChart() {
  const dailyData = useMemo(() => generateDailyData(), [])
  const hourlyData = useMemo(() => generateHourlyData(), [])
  const [view, setView] = useState<'chart' | 'list'>('chart')

  return (
    <div className="space-y-6">
      {/* Cost Over Time */}
      <div>
        <SectionTitle
          title="Cost Over Time"
          right={
            <div className="flex items-center border border-border">
              <button
                onClick={() => setView('chart')}
                className={`px-3 py-1 font-mono text-[10px] uppercase tracking-[1px] transition-colors ${view === 'chart' ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Chart
              </button>
              <button
                onClick={() => setView('list')}
                className={`border-l border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[1px] transition-colors ${view === 'list' ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                List
              </button>
            </div>
          }
        />

        {view === 'chart' ? (
          <div className="border border-border bg-card px-[22px] py-5">
            <div className="mb-4 flex flex-wrap gap-5 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
              <LegendDot color={COLOR_QUOTA} label="Quota-covered" />
              <LegendDot color={COLOR_WALLET} label="From wallet" />
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={dailyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: 'monospace', fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} interval={4} />
                <YAxis tick={{ fontSize: 9, fontFamily: 'monospace', fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontFamily: 'monospace', fontSize: 11 }}
                  formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name]}
                />
                <Area type="monotone" dataKey="quotaCovered" stackId="cost" stroke={COLOR_QUOTA} fill={COLOR_QUOTA} fillOpacity={0.6} strokeWidth={2} name="Quota-covered" />
                <Area type="monotone" dataKey="fromWallet" stackId="cost" stroke={COLOR_WALLET} fill={COLOR_WALLET} fillOpacity={0.7} strokeWidth={2} name="From wallet" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="border border-border bg-card px-[22px] py-4">
            <div className="grid grid-cols-[80px_1fr_1fr_1fr] gap-x-6 border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
              <span>Hour</span>
              <span className="text-right">Quota</span>
              <span className="text-right">Wallet</span>
              <span className="text-right">Total</span>
            </div>
            <div className="max-h-[240px] overflow-y-auto">
              {hourlyData.map((row) => (
                <div key={row.hour} className="grid grid-cols-[80px_1fr_1fr_1fr] gap-x-6 border-b border-border/30 py-[6px] font-mono text-[12px] tabular-nums">
                  <span className="text-muted-foreground">{row.hour}</span>
                  <span className={`text-right ${row.quota > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {row.quota > 0 ? `$${row.quota.toFixed(3)}` : '—'}
                  </span>
                  <span className={`text-right ${row.wallet > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                    {row.wallet > 0 ? `$${row.wallet.toFixed(3)}` : '—'}
                  </span>
                  <span className="text-right text-foreground">${(row.quota + row.wallet).toFixed(3)}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">Last 24 hours · per-hour granularity</p>
          </div>
        )}
      </div>

      {/* Concurrency timeline */}
      <div>
        <SectionTitle title="Concurrency Timeline" right={<span className="font-mono text-[10px] text-muted-foreground">limit = {LIMIT}</span>} />
        <div className="border border-border bg-card px-[22px] py-5">
          <ResponsiveContainer width="100%" height={140}>
            <ComposedChart data={dailyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: 'monospace', fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} interval={4} />
              <YAxis tick={{ fontSize: 9, fontFamily: 'monospace', fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} domain={[0, 120]} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontFamily: 'monospace', fontSize: 11 }}
                formatter={(value: number) => [`${value} boxes`, 'Concurrent']}
              />
              <ReferenceLine y={LIMIT} stroke={COLOR_LIMIT} strokeDasharray="6 3" label={{ value: `limit ${LIMIT}`, position: 'right', fontSize: 9, fontFamily: 'monospace', fill: 'hsl(var(--muted-foreground))' }} />
              <Line type="monotone" dataKey="concurrency" stroke={COLOR_LINE} strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: COLOR_LINE }} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> Boxes above the limit are rejected (429)
          </p>
        </div>
      </div>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-[8px]" style={{ background: color }} />
      {label}
    </span>
  )
}
