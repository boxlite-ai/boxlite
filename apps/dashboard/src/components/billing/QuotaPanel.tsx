/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Concurrency Wall — strictly per PRD §3.
// The wall is a single dimension: max concurrent sandbox count.
// Exceeding it → 1.5× burst pricing on excess boxes (Pro/Max) or hard 429 (Starter).

import { BRAND, SectionTitle } from './ascii'
import { PLANS, CURRENT_TIER } from './plans'

// TEMP(preview): demo live state
const RUNNING_BOXES = 61
const BURST_BOXES = 0 // boxes above the wall currently in 1.5× mode

export function QuotaBar({ used, limit, segments = 40 }: { used: number; limit: number; segments?: number }) {
  const ratio = limit > 0 ? used / limit : 0
  const filled = Math.max(0, Math.min(segments, Math.round(ratio * segments)))
  const color = ratio >= 0.9 ? 'hsl(var(--destructive))' : ratio >= 0.7 ? 'hsl(var(--warning))' : BRAND
  return (
    <div className="flex flex-1 gap-[3px]">
      {Array.from({ length: segments }).map((_, i) => (
        <span key={i} className="h-1.5 flex-1" style={{ background: i < filled ? color : 'hsl(var(--brand) / 0.15)' }} />
      ))}
    </div>
  )
}

export function QuotaPanel() {
  const plan = PLANS.find((p) => p.tier === CURRENT_TIER)!
  const wall = plan.concurrencyWall as number

  return (
    <div>
      <SectionTitle
        title="Concurrency Wall"
        right={
          <button
            className="font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => document.querySelector<HTMLElement>('[data-value="plan"]')?.click()}
          >
            upgrade plan →
          </button>
        }
      />

      <div className="border border-border bg-card px-[22px] py-5">
        {/* Running boxes vs wall */}
        <div className="flex items-center gap-5 font-mono text-[13px]">
          <span className="w-[120px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">Running</span>
          <span className="w-[100px] shrink-0 tabular-nums">
            <span className={RUNNING_BOXES >= wall ? 'text-destructive' : 'text-foreground'}>{RUNNING_BOXES}</span>
            <span className="text-muted-foreground"> / {wall}</span>
          </span>
          <QuotaBar used={RUNNING_BOXES} limit={wall} />
        </div>

        {/* Burst status */}
        <div className="mt-4 flex items-center gap-3 font-mono text-[12px]">
          <span className="size-[9px]" style={{ background: BURST_BOXES > 0 ? 'hsl(var(--warning))' : 'hsl(var(--muted-foreground) / 0.3)' }} />
          <span className={BURST_BOXES > 0 ? 'text-warning' : 'text-muted-foreground'}>
            {BURST_BOXES > 0
              ? `${BURST_BOXES} box${BURST_BOXES > 1 ? 'es' : ''} above wall — charged 1.5× CPU/Mem`
              : 'No burst — all boxes within wall'}
          </span>
        </div>

        {/* Wall policy */}
        <p className="mt-3 border-t border-border/40 pt-3 font-mono text-[11px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span>{' '}
          {plan.burstPolicy.includes('429')
            ? 'Exceeding the wall rejects new boxes (HTTP 429). Upgrade to remove the hard cap.'
            : `Exceeding the wall does not reject — excess boxes run at 1.5× CPU/Mem rate. Upgrade to raise the wall.`}
        </p>
      </div>
    </div>
  )
}
