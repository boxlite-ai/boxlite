/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { relTime, STATUS } from '@/lib/apps/format'
import type { AppPreview } from '@/lib/apps/types'
import { useState, type ReactNode } from 'react'

// Visual pieces the App pages add, in the console's language: a line sparkline,
// a row of stat cards (▸ LABEL, big value, as on Billing), a small bordered
// uppercase tag (as "CURRENT" on plans), and the production screenshot the
// proxy captures after a deployment.

export function Sparkline({
  data,
  color,
  width = 150,
  height = 34,
  className,
  onHover,
  hovered,
}: {
  data: number[]
  color: string
  width?: number
  height?: number
  className?: string
  /** Index under the pointer, or null when it leaves; makes the line readable point by point. */
  onHover?: (index: number | null) => void
  hovered?: number | null
}) {
  if (data.length < 2) {
    return <div className={cn('border-b border-dashed border-border', className)} style={{ width, height }} />
  }
  const max = Math.max(...data, 1)
  const step = width / (data.length - 1)
  const points = data.map((value, i) => [i * step, height - (value / max) * (height - 2) - 1] as const)
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const focus = hovered ?? points.length - 1
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', onHover && 'cursor-crosshair', className)}
      onMouseMove={
        onHover
          ? (e) => {
              const box = e.currentTarget.getBoundingClientRect()
              onHover(Math.max(0, Math.min(data.length - 1, Math.round((e.clientX - box.left) / step))))
            }
          : undefined
      }
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {hovered != null && (
        <line x1={points[focus][0]} x2={points[focus][0]} y1={0} y2={height} stroke={color} strokeOpacity={0.35} />
      )}
      <circle cx={points[focus][0]} cy={points[focus][1]} r={2.5} fill={color} />
    </svg>
  )
}

export interface Metric {
  label: string
  value: string
  unit?: string
  caption?: string
  tone?: 'neutral' | 'bad'
  data: number[]
  /** Shown when there is no data, e.g. "Not measured" or "No traffic yet". */
  empty?: string
}

/**
 * Four stat cards, each a bordered panel with a ▸ label, the value and a
 * sparkline. The line is the brand colour (it is live data); it turns red only
 * when the reading crosses its threshold (tone "bad").
 */
const hourLabel = (index: number, total: number) => {
  const ago = total - 1 - index
  return ago === 0 ? 'this hour' : `${ago}h ago`
}

export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  const [hover, setHover] = useState<{ metric: string; index: number } | null>(null)
  return (
    <div className="grid grid-cols-2 gap-[10px] xl:grid-cols-4">
      {metrics.map((m) => (
        <div key={m.label} className="flex flex-col gap-[14px] border border-border bg-card px-[22px] pb-5 pt-[18px]">
          <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
            <span className="text-brand">▸</span> {m.label}
          </span>
          <div className="flex items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex h-[28px] items-end font-mono leading-none">
                {m.data.length === 0 ? (
                  <span className="text-body text-muted-foreground">{m.empty ?? 'No traffic yet'}</span>
                ) : (
                  <span className="text-[26px] font-semibold tracking-tight tabular-nums text-foreground">
                    {m.value}
                    {m.unit && <span className="ml-1 text-[12px] font-normal text-muted-foreground">{m.unit}</span>}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'h-[16px] truncate font-mono text-[11px] leading-[16px]',
                  m.tone === 'bad' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {m.data.length === 0
                  ? null
                  : hover?.metric === m.label
                    ? `${hourLabel(hover.index, m.data.length)} · ${m.data[hover.index].toLocaleString('en-US')}${m.unit ? ` ${m.unit}` : ''}`
                    : m.caption}
              </span>
            </div>
            <Sparkline
              data={m.data}
              color={m.tone === 'bad' ? STATUS.error : 'hsl(var(--brand))'}
              width={96}
              height={28}
              hovered={hover?.metric === m.label ? hover.index : null}
              onHover={(index) => setHover(index === null ? null : { metric: m.label, index })}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Small bordered uppercase tag, as "CURRENT" / "BY REQUEST" on the plan cards. */
export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'good' | 'bad' | 'warn'
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center whitespace-nowrap border px-[6px] py-[2px] font-mono text-[9px] uppercase leading-none tracking-[1px]',
        tone === 'neutral' && 'border-border text-muted-foreground',
        tone === 'brand' && 'border-brand/50 text-brand',
        tone === 'good' && 'border-success/50 text-success',
        tone === 'bad' && 'border-destructive/50 text-destructive',
        tone === 'warn' && 'border-warning/50 text-warning',
      )}
    >
      {children}
    </span>
  )
}

/**
 * What the live URL showed at its last capture: the control plane renders the
 * app when a deployment goes live (and again when the picture is a day old).
 * Only a real capture is shown: no frame, no placeholder. Click opens the app.
 * The caption names the deployment and the time; it turns amber when the
 * picture is of an older deployment than the one serving now.
 */
export function LivePreview({
  preview,
  liveRelease,
  onOpen,
  name,
}: {
  preview: AppPreview
  liveRelease: string | null
  onOpen: () => void
  name: string
}) {
  const stale = preview.releaseId !== liveRelease
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${name}`}
        className="block border border-border outline-none transition-colors hover:border-brand focus-visible:ring-2 focus-visible:ring-brand/35"
      >
        <img
          src={preview.src}
          alt={`${name} at ${preview.releaseId}`}
          className="aspect-[16/10] w-full object-cover object-top"
          loading="lazy"
        />
      </button>
      <figcaption
        className={cn('font-mono text-meta', stale ? 'text-warning' : 'text-muted-foreground')}
        title={new Date(preview.capturedAt).toLocaleString()}
      >
        {stale ? `Screenshot from ${preview.releaseId}` : preview.releaseId} · captured {relTime(preview.capturedAt)}
      </figcaption>
    </figure>
  )
}
