/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// TEMP(preview): Wallet tab — balance + top-up + auto-reload + transaction history.
// Overage beyond quota draws from this balance. No burst.

import { useState } from 'react'
import { toast } from 'sonner'
import { BRAND, SectionTitle, CardBrand } from './ascii'
import { WALLET_BALANCE, WALLET_USED_THIS_MONTH, WALLET_TOTAL, WALLET_AUTO_RELOAD } from './plans'

const PRESETS = [25, 100, 500, 1000]

type Txn = { date: string; type: 'top-up' | 'usage' | 'subscription'; amount: number; status: 'ok' | 'pending' | 'failed' }

const TXNS: Txn[] = [
  { date: '2026-07-18', type: 'usage', amount: -4.20, status: 'ok' },
  { date: '2026-07-15', type: 'usage', amount: -8.10, status: 'ok' },
  { date: '2026-07-14', type: 'usage', amount: -6.30, status: 'ok' },
  { date: '2026-07-01', type: 'subscription', amount: -149.00, status: 'ok' },
  { date: '2026-07-01', type: 'top-up', amount: 100.00, status: 'ok' },
  { date: '2026-06-01', type: 'subscription', amount: -149.00, status: 'ok' },
  { date: '2026-05-15', type: 'top-up', amount: 50.00, status: 'ok' },
  { date: '2026-05-01', type: 'subscription', amount: -19.00, status: 'ok' },
  { date: '2026-04-20', type: 'top-up', amount: 100.00, status: 'failed' },
]

const ROW = 'grid grid-cols-[100px_110px_1fr_90px_80px] items-center gap-x-4'

export function BillingPanel() {
  const [preset, setPreset] = useState<number | null>(100)
  const [custom, setCustom] = useState('')
  const [autoOn, setAutoOn] = useState(WALLET_AUTO_RELOAD.enabled)
  const amount = preset ?? (parseFloat(custom) || 0)

  return (
    <div className="space-y-8">
      {/* Balance + top-up */}
      <div>
        <SectionTitle title="Wallet Balance" />
        <div className="border border-border bg-card px-[22px] py-5">
          {/* Current balance */}
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
              ${WALLET_BALANCE.toFixed(2)}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">available</span>
          </div>

          {/* Progress bar: used this month / total */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
              <span>Used this month</span>
              <span className="tabular-nums">${WALLET_USED_THIS_MONTH.toFixed(2)} / ${WALLET_TOTAL.toFixed(2)}</span>
            </div>
            <div className="flex gap-[3px]">
              {Array.from({ length: 40 }).map((_, i) => {
                const ratio = WALLET_USED_THIS_MONTH / WALLET_TOTAL
                const filled = i < Math.round(ratio * 40)
                const color = ratio >= 0.9 ? 'hsl(var(--destructive))' : ratio >= 0.7 ? 'hsl(var(--warning))' : BRAND
                return <span key={i} className="h-1.5 flex-1" style={{ background: filled ? color : 'hsl(var(--brand) / 0.15)' }} />
              })}
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> {Math.round((WALLET_USED_THIS_MONTH / WALLET_TOTAL) * 100)}% of wallet drawn this cycle for overage
            </p>
          </div>

          <div className="my-5 h-px bg-border" />

          {/* Top-up */}
          <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Add funds</span>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => { setPreset(p); setCustom('') }}
                className={`border px-4 py-2 font-mono text-[13px] tabular-nums transition-colors ${
                  preset === p ? 'bg-foreground text-background' : 'border-border text-foreground hover:border-brand'
                }`}
              >
                ${p}
              </button>
            ))}
            <div className="flex items-center border border-border px-3 py-2 font-mono text-[13px] transition-colors hover:border-brand focus-within:border-brand">
              <span className="text-muted-foreground">$</span>
              <input
                value={custom}
                onChange={(e) => { setCustom(e.target.value); setPreset(null) }}
                placeholder="custom"
                className="w-20 bg-transparent pl-1 tabular-nums text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <button
              disabled={!amount}
              onClick={() => toast.success(`Top-up of $${amount.toFixed(2)} initiated`)}
              className="ml-auto bg-foreground px-4 py-2 font-mono text-[12px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Top up →
            </button>
          </div>

          <div className="my-5 h-px bg-border" />

          {/* Auto-reload */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                Auto-reload
                <span className="size-[6px] rounded-full" style={{ background: autoOn ? BRAND : 'hsl(var(--muted-foreground))' }} />
              </span>
              <span className="font-mono text-[13px] text-foreground">
                {autoOn ? `when balance < $${WALLET_AUTO_RELOAD.threshold} → add $${WALLET_AUTO_RELOAD.amount}` : 'disabled'}
              </span>
            </div>
            <button
              onClick={() => { setAutoOn(!autoOn); toast.success(autoOn ? 'Auto-reload disabled' : 'Auto-reload enabled') }}
              className="border border-border px-4 py-2 font-mono text-[12px] text-foreground transition-colors hover:border-brand"
            >
              {autoOn ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      </div>

      {/* Payment method */}
      <div>
        <SectionTitle title="Payment Method" />
        <div className="border border-border bg-card px-[22px] py-4">
          <div className="flex flex-wrap items-center gap-4">
            <CardBrand brand="visa" size="lg" />
            <span className="font-mono text-[18px] tracking-[2px] text-foreground">···· 4242</span>
            <span className="font-mono text-[12px] text-muted-foreground">exp 08/27</span>
            <button
              className="ml-auto border border-border px-4 py-2 font-mono text-[12px] text-foreground transition-colors hover:border-brand"
              onClick={() => toast.info('Redirecting to card update…')}
            >
              Update card
            </button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> Used for subscription renewal and top-up charges
          </p>
        </div>
      </div>

      {/* Transaction history */}
      <div>
        <SectionTitle title="Transactions" count={`${TXNS.length} records`} />
        <div className={`${ROW} border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`}>
          <span>Date</span>
          <span>Type</span>
          <span></span>
          <span className="text-right">Amount</span>
          <span className="text-right">Status</span>
        </div>
        {TXNS.map((t, i) => (
          <div key={i} className={`${ROW} border-b border-border/40 py-[13px] font-mono text-[13px] transition-colors hover:bg-muted/30`}>
            <span className="text-foreground">{t.date}</span>
            <span className="uppercase tracking-[0.5px] text-muted-foreground">{t.type}</span>
            <span></span>
            <span className={`text-right tabular-nums ${t.amount >= 0 ? 'text-success' : 'text-foreground'}`}>
              {t.amount >= 0 ? '+' : ''}{t.amount.toFixed(2)}
            </span>
            <span className="text-right">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-[9px]" style={{ background: t.status === 'ok' ? 'hsl(var(--success))' : t.status === 'failed' ? 'hsl(var(--destructive))' : 'hsl(var(--warning))' }} />
                <span className={t.status === 'failed' ? 'text-destructive' : 'text-foreground'}>{t.status}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
