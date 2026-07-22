/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Alert banners for billing edge states.
// No burst / no bad_debt. States: balance_low, suspended, credit_exhausted.

import { toast } from 'sonner'
import { BRAND } from './ascii'
import {
  DEMO_USER_STATE,
  WALLET_BALANCE,
  WALLET_AUTO_RELOAD,
  FREE_CREDIT_REMAINING,
  FREE_CREDIT_TOTAL,
  DESTRUCTION_COUNTDOWN_DAYS,
} from './plans'

export function AlertBanners() {
  switch (DEMO_USER_STATE) {
    case 'balance_low':
      return <BalanceLowBanner />
    case 'suspended':
      return <SuspendedBanner />
    case 'credit_exhausted':
      return <CreditExhaustedBanner />
    default:
      return null
  }
}

// ─── Balance low warning ─────────────────────────────────────────────────────

function BalanceLowBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-warning/60 bg-warning/10 px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 font-mono text-[12px] font-semibold text-warning">
          <span className="size-[9px]" style={{ background: 'hsl(var(--warning))' }} />
          Wallet balance low — ${WALLET_BALANCE.toFixed(2)} remaining
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {WALLET_AUTO_RELOAD.enabled
            ? `Auto-reload will add $${WALLET_AUTO_RELOAD.amount} when balance drops below $${WALLET_AUTO_RELOAD.threshold}.`
            : 'Enable auto-reload or top up manually to avoid service interruption when quota is exhausted.'}
        </span>
      </div>
      <button
        className="border border-warning/60 px-4 py-2 font-mono text-[12px] text-warning transition-colors hover:bg-warning/10"
        onClick={() => document.querySelector<HTMLElement>('[data-value="billing"]')?.click()}
      >
        Top up →
      </button>
    </div>
  )
}

// ─── Suspended (balance depleted + quota exhausted) ──────────────────────────

function SuspendedBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-destructive/60 bg-destructive/10 px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 font-mono text-[12px] font-semibold text-destructive">
          <span className="size-[9px]" style={{ background: 'hsl(var(--destructive))' }} />
          Service suspended — balance depleted
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          Top up to resume immediately, or wait — quota resets next cycle and service resumes automatically.
          Data retained for 14 days.
        </span>
      </div>
      <button
        className="bg-foreground px-4 py-2 font-mono text-[12px] font-semibold text-background transition-opacity hover:opacity-90"
        onClick={() => { toast.info('Redirecting to top-up…'); document.querySelector<HTMLElement>('[data-value="billing"]')?.click() }}
      >
        Top up to resume →
      </button>
    </div>
  )
}

// ─── Credit exhausted + countdown (free trial, no subscription) ──────────────

function CreditExhaustedBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-destructive/60 bg-destructive/10 px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 font-mono text-[12px] font-semibold text-destructive">
          <span className="size-[9px]" style={{ background: 'hsl(var(--destructive))' }} />
          Free credits depleted — all boxes suspended
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          Data will be <span className="font-semibold text-destructive">permanently destroyed in {DESTRUCTION_COUNTDOWN_DAYS} days</span>.
          Top up or start a plan to keep your data and restore service.
        </span>
      </div>
      <button
        className="bg-foreground px-4 py-2 font-mono text-[12px] font-semibold text-background transition-opacity hover:opacity-90"
        onClick={() => document.querySelector<HTMLElement>('[data-value="overview"]')?.click()}
      >
        Choose a plan →
      </button>
    </div>
  )
}

// ─── Free trial banner (Usage tab) ───────────────────────────────────────────

export function FreeTrialBanner() {
  if (DEMO_USER_STATE !== 'free_trial') return null
  const ratio = (FREE_CREDIT_TOTAL - FREE_CREDIT_REMAINING) / FREE_CREDIT_TOTAL

  return (
    <div className="border border-border bg-card px-[22px] py-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Free credits
        </span>
        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          ${FREE_CREDIT_REMAINING.toFixed(2)}
          <span className="ml-2 text-[13px] font-normal text-muted-foreground">/ ${FREE_CREDIT_TOTAL.toFixed(2)}</span>
        </span>
      </div>
      <div className="mt-4 flex items-center gap-4 font-mono text-[12px]">
        <span className="w-[100px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">Used</span>
        <div className="flex flex-1 gap-[3px]">
          {Array.from({ length: 40 }).map((_, i) => (
            <span key={i} className="h-1.5 flex-1" style={{ background: i < Math.round(ratio * 40) ? BRAND : 'hsl(var(--brand) / 0.15)' }} />
          ))}
        </div>
      </div>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
        <span style={{ color: BRAND }}>▸</span> Your wallet balance. When it reaches $0, boxes are suspended. After 7 days, data is destroyed.
      </p>
    </div>
  )
}
