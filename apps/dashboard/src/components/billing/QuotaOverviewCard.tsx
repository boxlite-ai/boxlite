/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// TEMP(preview): Unified "This Cycle" card — quota + wallet balance + concurrency.
// No burst. Concurrency = hard limit. Overage draws from wallet.

import { BRAND, SectionTitle } from './ascii'
import { PLANS, CURRENT_TIER, DEMO_QUOTA_USED, DEMO_CONCURRENT, WALLET_BALANCE } from './plans'

export function QuotaBar({ used, limit, segments = 40 }: { used: number; limit: number; segments?: number }) {
  const ratio = limit > 0 ? used / limit : 0
  const filled = Math.max(0, Math.min(segments, Math.round(ratio * segments)))
  const color = ratio >= 0.9 ? 'hsl(var(--destructive))' : ratio >= 0.8 ? 'hsl(var(--warning))' : BRAND
  return (
    <div className="flex flex-1 gap-[3px]">
      {Array.from({ length: segments }).map((_, i) => (
        <span key={i} className="h-1.5 flex-1" style={{ background: i < filled ? color : 'hsl(var(--brand) / 0.15)' }} />
      ))}
    </div>
  )
}

export function QuotaOverviewCard() {
  const plan = PLANS.find((p) => p.tier === CURRENT_TIER)!
  const quotaTotal = plan.quotaUsd ?? 0
  const limit = plan.concurrencyLimit as number
  const daysLeft = 11
  const atLimit = DEMO_CONCURRENT >= limit
  const nearLimit = DEMO_CONCURRENT >= limit * 0.8

  return (
    <div>
      <SectionTitle title="This Cycle" />
      <div className="border border-border bg-card">
        {/* Metrics row */}
        <div className="flex flex-col gap-6 px-[22px] py-6 sm:flex-row sm:gap-14">
          <Metric label="Quota consumed" value={`$${DEMO_QUOTA_USED.toFixed(2)}`} sub={`of $${quotaTotal.toFixed(2)} included`} />
          <Metric label="Wallet balance" value={`$${WALLET_BALANCE.toFixed(2)}`} sub="prepaid · never expires" />
          <Metric label="Cycle ends in" value={`${daysLeft}`} sub="days" />
        </div>

        {/* Quota bar */}
        <div className="border-t border-border px-[22px] py-4">
          <BarRow label="Quota used" used={DEMO_QUOTA_USED} limit={quotaTotal} display={`$${DEMO_QUOTA_USED.toFixed(2)} / $${quotaTotal.toFixed(2)}`} />
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> Included in plan · resets each cycle · unused quota does not carry over
          </p>
        </div>

        {/* Wallet balance bar (visual: how much buffer remains) */}
        <div className="border-t border-border px-[22px] py-4">
          <div className="flex items-center gap-4 font-mono text-[12px]">
            <span className="w-[100px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">Wallet</span>
            <span className="w-[140px] shrink-0 tabular-nums text-foreground">${WALLET_BALANCE.toFixed(2)}</span>
            <div className="flex flex-1 gap-[3px]">
              {Array.from({ length: 40 }).map((_, i) => (
                <span key={i} className="h-1.5 flex-1" style={{ background: i < 35 ? BRAND : 'hsl(var(--brand) / 0.15)' }} />
              ))}
            </div>
          </div>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> Drawn when quota is exhausted · top up in Wallet tab
          </p>
        </div>

        {/* Concurrency — hard limit */}
        <div className="border-t border-border px-[22px] py-4">
          <BarRow label="Concurrent" used={DEMO_CONCURRENT} limit={limit} display={`${DEMO_CONCURRENT} / ${limit}`} />
          <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px]">
            <span className="size-[7px]" style={{ background: atLimit ? 'hsl(var(--destructive))' : nearLimit ? 'hsl(var(--warning))' : 'hsl(var(--muted-foreground) / 0.3)' }} />
            <span className={atLimit ? 'text-destructive' : nearLimit ? 'text-warning' : 'text-muted-foreground'}>
              {atLimit
                ? 'At limit — new boxes rejected (429)'
                : nearLimit
                  ? `${limit - DEMO_CONCURRENT} slots remaining`
                  : 'Within limit'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

function BarRow({ label, used, limit, display }: { label: string; used: number; limit: number; display: string }) {
  return (
    <div className="flex items-center gap-4 font-mono text-[12px]">
      <span className="w-[100px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className="w-[140px] shrink-0 tabular-nums text-foreground">{display}</span>
      <QuotaBar used={used} limit={limit} />
    </div>
  )
}
