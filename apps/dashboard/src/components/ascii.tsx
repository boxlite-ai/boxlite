/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import type { ComponentProps, ReactNode } from 'react'

/**
 * Shared primitives for the terminal/ASCII design language.
 *
 * These are presentation only — they take plain display values, never domain
 * objects — so a screen can adopt the look without the primitive learning
 * anything about boxes, wallets or plans.
 */

export const BRAND = 'hsl(var(--brand))'

// 5x7 dot-matrix LED glyphs — renders hero numbers as a dot display (telemetry/monitor vibe).
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

const isNumeric = (s: string) => /^[\d.,]+$/.test(s)

function DotMatrix({ text, dot = 4, gap = 1 }: { text: string; dot?: number; gap?: number }) {
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

// `onClick` turns the card into a filter control: on an inventory screen the
// counts are the fastest way to narrow the list, so making them inert wastes
// the most prominent element on the page. Cards without it stay plain divs.
export function StatCard({
  label,
  value,
  sub,
  live,
  onClick,
  active,
}: {
  label: string
  value: string
  sub: string
  live?: boolean
  onClick?: () => void
  active?: boolean
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, 'aria-pressed': active } : {})}
      className={cn(
        'flex flex-col gap-2 border bg-card px-3 py-2.5 text-left transition-transform hover:-translate-y-0.5 sm:gap-[14px] sm:px-[22px] sm:pb-5 sm:pt-[18px]',
        active ? 'border-brand' : 'border-border',
        onClick && !active && 'hover:border-muted-foreground/50',
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="font-mono text-[9px] uppercase leading-tight tracking-[1px] text-muted-foreground sm:whitespace-nowrap sm:text-[10px] sm:tracking-[1.5px]">
          <span style={{ color: BRAND }}>▸</span> {label}
        </span>
        {live && (
          <span className="inline-flex shrink-0 items-center gap-[5px] font-mono text-[9px] tracking-[1px] text-muted-foreground">
            <span
              className="size-[6px] rounded-full"
              style={{ background: BRAND, animation: 'live-pulse 1.6s infinite' }}
            />
            <span className="hidden sm:inline">LIVE</span>
          </span>
        )}
      </div>
      {/* mobile: compact numeric value (the dot-matrix is too tall for a 3-up row) */}
      <div className="font-mono text-[20px] font-semibold leading-none tracking-[-0.5px] sm:hidden">{value}</div>
      {/* desktop: dot-matrix value + sub label */}
      <div className="hidden items-end gap-[10px] sm:flex">
        {isNumeric(value) ? (
          <span className="text-foreground">
            <DotMatrix text={value} />
          </span>
        ) : (
          <div className="font-mono text-[34px] font-semibold leading-none tracking-[-1px]">{value}</div>
        )}
        <span className="mb-[2px] font-mono text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{sub}</span>
      </div>
    </Tag>
  )
}

/** Section heading: ▸ TITLE, optional count, optional right-aligned action. */
export function SectionTitle({ title, count, right }: { title: string; count?: ReactNode; right?: ReactNode }) {
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

/**
 * Segmented progress bar. Warns at 80% and alerts at 90% of `limit`, so a bar
 * reads as a status at a glance rather than needing its label parsed.
 * `limit` of 0 renders an empty track — callers with no ceiling to show pass 0.
 */
export function SegmentedBar({ used, limit, segments = 40 }: { used: number; limit: number; segments?: number }) {
  const ratio = limit > 0 ? used / limit : 0
  const filled = Math.max(0, Math.min(segments, Math.round(ratio * segments)))
  const color = ratio >= 0.9 ? 'hsl(var(--destructive))' : ratio >= 0.8 ? 'hsl(var(--warning))' : BRAND
  return (
    <div className="flex flex-1 gap-[3px]">
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className="h-1.5 flex-1"
          style={{ background: i < filled ? color : 'hsl(var(--brand) / 0.15)' }}
        />
      ))}
    </div>
  )
}

/** Label / big value / caption triple used in card headers. */
export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        <span style={{ color: BRAND }}>▸</span> {label}
      </span>
      <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      {sub && <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

/**
 * Flat terminal button. The design language has no rounded/elevated controls, so
 * these bypass the shadcn Button rather than fighting its variants.
 */
export function AsciiButton({
  variant = 'secondary',
  className,
  children,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' }) {
  return (
    <button
      type={type}
      className={cn(
        'px-4 py-2 font-mono text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary'
          ? 'bg-foreground font-semibold text-background transition-opacity hover:opacity-90'
          : 'border border-border text-foreground hover:border-brand',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/** Selectable chip — used for top-up presets. */
export function AsciiChip({
  selected,
  className,
  children,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'border px-4 py-2 font-mono text-[13px] tabular-nums transition-colors',
        selected
          ? 'border-foreground bg-foreground text-background'
          : 'border-border text-foreground hover:border-brand',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

const STATUS_COLOR = {
  ok: 'hsl(var(--success))',
  warn: 'hsl(var(--warning))',
  bad: 'hsl(var(--destructive))',
  idle: 'hsl(var(--muted-foreground))',
} as const

/** Square swatch + label. Replaces rounded badges, which clash with the square language. */
export function StatusMark({ tone, children }: { tone: keyof typeof STATUS_COLOR; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
      <span className="size-[9px] shrink-0" style={{ background: STATUS_COLOR[tone] }} />
      <span className={tone === 'bad' ? 'text-destructive' : 'text-foreground'}>{children}</span>
    </span>
  )
}

/** Bordered panel — the standard container for a section's content. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('border border-border bg-card', className)}>{children}</div>
}

/**
 * A note under a bar or field: plain explanatory text, no leading marker.
 *
 * The `▸` glyph is reserved for section/heading labels (`SectionTitle`, and
 * the inline heading treatment some dialogs use in its place) — it marks
 * "this line names a section". Putting it on body text too made a heading
 * and a caption underneath it look like the same kind of line.
 */
export function PanelNote({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{children}</p>
}
