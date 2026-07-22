/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { ChartConfig, ChartContainer } from '@/components/ui/chart'
import { Area, AreaChart } from 'recharts'
import type { ReactNode } from 'react'

export const BRAND = 'hsl(196 100% 47%)'

// 5x7 dot-matrix LED glyphs — renders numbers as a dot display (telemetry/monitor vibe).
const DM_GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00', '00', '00', '00', '00', '11', '11'],
  ',': ['00', '00', '00', '00', '00', '11', '10'],
}

export function DotMatrix({ text, dot = 4, gap = 1 }: { text: string; dot?: number; gap?: number }) {
  return (
    <div className="flex items-end" style={{ gap: `${dot + gap}px` }}>
      {[...text].map((ch, i) => {
        const rows = DM_GLYPHS[ch]
        if (!rows) return <span key={i} style={{ width: `${dot * 2}px` }} />
        const cols = rows[0].length
        return (
          <div
            key={i}
            className="grid"
            style={{ gridTemplateColumns: `repeat(${cols}, ${dot}px)`, gridAutoRows: `${dot}px`, gap: `${gap}px` }}
          >
            {rows.flatMap((r, y) =>
              [...r].map((c, x) => (
                <span
                  key={`${y}-${x}`}
                  style={{
                    width: `${dot}px`,
                    height: `${dot}px`,
                    borderRadius: '50%',
                    background: c === '1' ? 'currentColor' : 'transparent',
                  }}
                />
              )),
            )}
          </div>
        )
      })}
    </div>
  )
}

const sparkConfig: ChartConfig = { v: { label: 'v', color: BRAND } }

export function MiniSpark({ id, data }: { id: string; data: { v: number }[] }) {
  return (
    <ChartContainer config={sparkConfig} className="aspect-auto h-11 w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BRAND} stopOpacity={0.25} />
            <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          dataKey="v"
          type="monotone"
          stroke={BRAND}
          strokeWidth={1.5}
          fill={`url(#spark-${id})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function LivePulse() {
  return (
    <span className="inline-flex items-center gap-[6px] font-mono text-[9px] tracking-[1px] text-muted-foreground">
      <span className="size-[6px] rounded-full" style={{ background: BRAND, animation: 'live-pulse 1.6s infinite' }} />
      LIVE
    </span>
  )
}

interface AsciiStatCardProps {
  label: string
  prefix?: string
  value: string
  unit?: string
  trendPct?: number
  spark?: { id: string; data: { v: number }[] }
  live?: boolean
  index?: string
  dot?: number
}

export function AsciiStatCard({ label, prefix, value, unit, trendPct, spark, live, index, dot = 2 }: AsciiStatCardProps) {
  const up = (trendPct ?? 0) >= 0
  return (
    <div className="flex flex-col gap-[14px] border border-border bg-card px-[22px] pb-5 pt-[18px] transition-transform hover:-translate-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> {label}
        </span>
        {live ? (
          <LivePulse />
        ) : trendPct !== undefined ? (
          <span className={cn('font-mono text-[10px] tabular-nums', up ? 'text-success' : 'text-destructive')}>
            {up ? '▲' : '▼'} {Math.abs(trendPct)}%
          </span>
        ) : index ? (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{index}</span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-[6px] text-foreground">
        {prefix && <span className="font-mono text-[20px] font-semibold leading-none tracking-tight">{prefix}</span>}
        <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums">{value}</span>
        {unit && (
          <span className="font-mono text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{unit}</span>
        )}
      </div>
      {spark && <MiniSpark id={spark.id} data={spark.data} />}
    </div>
  )
}

/** 统一功能组小标题：▸ TITLE（左）+ 可选 count + 可选右侧操作 */
export function SectionTitle({ title, count, right }: { title: string; count?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-[2px]">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-foreground">
          <span style={{ color: BRAND }}>▸</span> {title}
        </span>
        {count && <span className="font-mono text-[11px] text-muted-foreground">{count}</span>}
      </div>
      {right}
    </div>
  )
}

/** 卡品牌 logo（演示：VISA / Mastercard），支持 sm / lg */
export function CardBrand({ brand = 'visa', size = 'sm' }: { brand?: 'visa' | 'mastercard'; size?: 'sm' | 'lg' }) {
  const lg = size === 'lg'
  if (brand === 'mastercard') {
    const d = lg ? 16 : 10
    return (
      <span className={cn('inline-flex items-center gap-[2px] rounded bg-white', lg ? 'px-2 py-1.5' : 'px-[5px] py-[3px]')}>
        <span className="rounded-full bg-[#EB001B]" style={{ width: d, height: d }} />
        <span className="-ml-[6px] rounded-full bg-[#F79E1B] opacity-90" style={{ width: d, height: d }} />
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded bg-white font-bold italic leading-none tracking-[-0.5px] text-[#1A1F71]',
        lg ? 'px-[11px] py-[7px] text-[18px]' : 'px-[6px] py-[2px] text-[11px]',
      )}
    >
      VISA
    </span>
  )
}
