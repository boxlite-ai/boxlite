/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ChartConfig, ChartContainer } from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'
import { Area, AreaChart } from 'recharts'

export const BILLING_BRAND = 'hsl(196 100% 47%)'

const DOT_MATRIX_GLYPHS: Record<string, string[]> = {
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
  '-': ['000', '000', '000', '111', '000', '000', '000'],
}

export function DotMatrix({ text, dot = 3, gap = 1 }: { text: string; dot?: number; gap?: number }) {
  return (
    <span className="inline-flex items-end leading-none" aria-label={text} style={{ gap: `${dot + gap}px` }}>
      {[...text].map((character, index) => {
        const rows = DOT_MATRIX_GLYPHS[character]
        if (!rows) return <span key={`${character}-${index}`} style={{ width: `${dot * 2}px` }} />

        return (
          <span
            key={`${character}-${index}`}
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${rows[0].length}, ${dot}px)`,
              gridAutoRows: `${dot}px`,
              gap: `${gap}px`,
            }}
          >
            {rows.flatMap((row, rowIndex) =>
              [...row].map((cell, columnIndex) => (
                <span
                  key={`${rowIndex}-${columnIndex}`}
                  className="rounded-full"
                  style={{
                    width: `${dot}px`,
                    height: `${dot}px`,
                    background: cell === '1' ? 'currentColor' : 'transparent',
                  }}
                />
              )),
            )}
          </span>
        )
      })}
    </span>
  )
}

export function MatrixAmount({
  prefix,
  value,
  unit,
  size = 'sm',
}: {
  prefix?: string
  value: string
  unit?: string
  size?: 'sm' | 'lg'
}) {
  const isLarge = size === 'lg'
  return (
    <div className="flex min-h-9 min-w-0 items-end gap-1.5 text-foreground">
      {prefix ? (
        <span className={cn('shrink-0 font-mono font-semibold leading-none', isLarge ? 'text-[16px]' : 'text-[13px]')}>
          {prefix}
        </span>
      ) : null}
      <span className="min-w-0 overflow-hidden">
        <DotMatrix text={value} dot={isLarge ? 3 : 2} gap={1} />
      </span>
      {unit ? (
        <span className="mb-0.5 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{unit}</span>
      ) : null}
    </div>
  )
}

export function SectionTitle({ title, count, right }: { title: string; count?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-3 px-0.5">
      <div className="flex items-center gap-3">
        <h2 className="font-mono text-[11px] uppercase text-foreground">
          <span style={{ color: BILLING_BRAND }}>▸</span> {title}
        </h2>
        {count ? <span className="font-mono text-[11px] text-muted-foreground">{count}</span> : null}
      </div>
      {right}
    </div>
  )
}

export function CardBrand({ brand, size = 'sm' }: { brand: string; size?: 'sm' | 'lg' }) {
  const normalizedBrand = brand.toLowerCase()
  const isLarge = size === 'lg'
  if (normalizedBrand === 'mastercard') {
    const diameter = isLarge ? 16 : 10
    return (
      <span
        className={cn('inline-flex items-center gap-0.5 rounded bg-white', isLarge ? 'px-2 py-1.5' : 'px-1 py-0.5')}
      >
        <span className="rounded-full bg-[#EB001B]" style={{ width: diameter, height: diameter }} />
        <span className="-ml-1.5 rounded-full bg-[#F79E1B] opacity-90" style={{ width: diameter, height: diameter }} />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded bg-white font-bold italic leading-none text-[#1A1F71]',
        isLarge ? 'px-3 py-2 text-[18px]' : 'px-1.5 py-0.5 text-[11px]',
      )}
    >
      {normalizedBrand === 'visa' ? 'VISA' : normalizedBrand.toUpperCase() || 'CARD'}
    </span>
  )
}

const sparkConfig: ChartConfig = { value: { label: 'value', color: BILLING_BRAND } }

function MiniSpark({ id, data }: { id: string; data: { value: number }[] }) {
  return (
    <ChartContainer config={sparkConfig} className="aspect-auto h-12 w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`billing-spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BILLING_BRAND} stopOpacity={0.25} />
            <stop offset="100%" stopColor={BILLING_BRAND} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          dataKey="value"
          type="monotone"
          stroke={BILLING_BRAND}
          strokeWidth={1.5}
          fill={`url(#billing-spark-${id})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function AsciiStatCard({
  id,
  label,
  prefix,
  value,
  unit,
  trendPct,
  data,
}: {
  id: string
  label: string
  prefix?: string
  value: string
  unit?: string
  trendPct?: number
  data: { value: number }[]
}) {
  const trendUp = (trendPct ?? 0) >= 0
  return (
    <div
      data-usage-card
      className="flex min-h-[188px] min-w-0 flex-col gap-4 border border-border bg-card px-5 pb-4 pt-[18px]"
    >
      <div className="flex min-h-4 items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] uppercase text-muted-foreground">
          <span style={{ color: BILLING_BRAND }}>▸</span> {label}
        </span>
        {trendPct !== undefined ? (
          <span className={cn('shrink-0 font-mono text-[10px]', trendUp ? 'text-success' : 'text-destructive')}>
            {trendUp ? '▲' : '▼'} {Math.abs(trendPct)}%
          </span>
        ) : null}
      </div>
      <MatrixAmount prefix={prefix} value={value} unit={unit} />
      <span className="font-mono text-[9px] uppercase text-muted-foreground">total over range</span>
      <div className="mt-auto min-h-12">{data.length > 0 ? <MiniSpark id={id} data={data} /> : null}</div>
    </div>
  )
}
