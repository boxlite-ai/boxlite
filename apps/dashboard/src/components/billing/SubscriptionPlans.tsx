/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// TEMP(preview): Subscription plan view — active plan banner + 4-card comparison grid.
// No real hook wiring yet; data from plans.ts.

import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { BRAND, SectionTitle } from './ascii'
import { AlertBanners } from './AlertBanners'
import {
  PLANS,
  CURRENT_TIER,
  DEMO_USER_STATE,
  DEMO_QUOTA_USED,
  WALLET_BALANCE,
  FREE_CREDIT_REMAINING,
  FREE_CREDIT_TOTAL,
  type SubscriptionPlan,
} from './plans'

// ─── Active Plan Banner ──────────────────────────────────────────────────────

function ActivePlanBanner() {
  const plan = PLANS.find((p) => p.tier === CURRENT_TIER)!
  const quotaTotal = plan.quotaUsd ?? 0

  return (
    <div className="border border-border bg-card">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-4 px-[22px] py-5">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> T{plan.tier}
          </span>
          <span className="font-mono text-[18px] font-semibold tracking-tight text-foreground">
            {plan.name}
            <span className="ml-1 animate-pulse text-muted-foreground">▮</span>
          </span>
          <span className="bg-foreground px-2 py-0.5 font-mono text-[10px] uppercase tracking-[1px] text-background">
            active
          </span>
        </div>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">${plan.priceMonthly}/mo · {plan.audience}</span>
      </div>

      {/* High-level metrics */}
      <div className="flex flex-col gap-6 border-t border-border px-[22px] py-5 sm:flex-row sm:gap-14">
        <Metric label="Subscription" value={plan.name} unit={`$${plan.priceMonthly}/mo`} />
        <Metric label="Wallet balance" value={`$${WALLET_BALANCE.toFixed(2)}`} />
        <Metric label="Quota consumed" value={`$${DEMO_QUOTA_USED.toFixed(2)}`} unit={`/ $${quotaTotal.toFixed(2)}`} />
      </div>
    </div>
  )
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        <span style={{ color: BRAND }}>▸</span> {label}
      </span>
      <span className="font-mono text-[22px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value}
        {unit && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{unit}</span>}
      </span>
    </div>
  )
}

// ─── Free Credit Banner ──────────────────────────────────────────────────────

function FreeCreditBanner() {
  const ratio = (FREE_CREDIT_TOTAL - FREE_CREDIT_REMAINING) / FREE_CREDIT_TOTAL
  return (
    <div className="border border-border bg-card">
      <div className="px-[22px] py-5">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
            <span style={{ color: BRAND }}>▸</span> Remaining
          </span>
          <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
            ${FREE_CREDIT_REMAINING.toFixed(2)}
            <span className="ml-2 text-[13px] font-normal text-muted-foreground">/ ${FREE_CREDIT_TOTAL.toFixed(2)}</span>
          </span>
        </div>
        <div className="mt-4 flex items-center gap-4 font-mono text-[12px]">
          <span className="w-[80px] shrink-0 text-muted-foreground">Used</span>
          <div className="flex flex-1 gap-[3px]">
            {Array.from({ length: 40 }).map((_, i) => (
              <span key={i} className="h-1.5 flex-1" style={{ background: i < Math.round(ratio * 40) ? BRAND : 'hsl(var(--brand) / 0.15)' }} />
            ))}
          </div>
        </div>
        <p className="mt-3 font-mono text-[11px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> No subscription required. When credits reach $0, boxes are suspended. After 7 days, data is destroyed.
        </p>
      </div>
    </div>
  )
}

// ─── Plan Card (grid item) ───────────────────────────────────────────────────

function PlanCard({ plan, onSwitch, freeTrial }: { plan: SubscriptionPlan; onSwitch: (p: SubscriptionPlan) => void; freeTrial?: boolean }) {
  const isActive = !freeTrial && plan.tier === CURRENT_TIER
  const isUpgrade = plan.tier > CURRENT_TIER

  return (
    <div
      className={`flex flex-col border bg-card px-[22px] py-5 transition-transform hover:-translate-y-0.5 ${
        isActive ? 'border-brand/60' : 'border-border hover:border-brand/40'
      }`}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> T{plan.tier} · {plan.name}
        </span>
        {isActive && (
          <span className="bg-foreground px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-background">
            current
          </span>
        )}
      </div>

      {/* Price */}
      <div className="mb-4">
        {plan.custom ? (
          <div>
            <span className="font-mono text-[26px] font-semibold leading-none tracking-tight text-foreground">
              Custom
            </span>
            <span className="ml-2 font-mono text-[10px] text-muted-foreground">from $2,000/mo</span>
          </div>
        ) : (
          <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
            <span className="text-[16px]">$</span>
            {plan.priceMonthly}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">/mo</span>
          </span>
        )}
      </div>

      {/* Specs */}
      <div className="mb-5 flex-1 divide-y divide-border/40">
        <SpecRow label="Quota" value={plan.quotaUsd ? `$${plan.quotaUsd}` : '—'} />
        <SpecRow label="Leverage" value={plan.quotaLeverage ?? '—'} />
        <SpecRow
          label="Concurrency"
          value={plan.concurrencyLimit === 'unlimited' ? 'Unlimited' : `${plan.concurrencyLimit} boxes`}
        />
      </div>

      {/* Audience */}
      <p className="mb-4 font-mono text-[11px] leading-relaxed text-muted-foreground">{plan.audience}</p>

      {/* CTA */}
      {plan.custom ? (
        <a
          href="mailto:sales@boxlite.ai?subject=Enterprise%20inquiry"
          className="block border border-border px-4 py-2 text-center font-mono text-[12px] text-foreground transition-colors hover:border-brand"
        >
          Contact sales →
        </a>
      ) : freeTrial ? (
        <button
          onClick={() => onSwitch(plan)}
          className="block w-full bg-foreground px-4 py-2 text-center font-mono text-[12px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          Start →
        </button>
      ) : isActive ? (
        <button
          disabled
          className="block w-full border border-border px-4 py-2 text-center font-mono text-[12px] text-muted-foreground opacity-40"
        >
          Current plan
        </button>
      ) : isUpgrade ? (
        <button
          onClick={() => onSwitch(plan)}
          className="block w-full bg-foreground px-4 py-2 text-center font-mono text-[12px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          Upgrade →
        </button>
      ) : (
        <button
          onClick={() => onSwitch(plan)}
          className="block w-full border border-border px-4 py-2 text-center font-mono text-[12px] text-foreground transition-colors hover:border-brand"
        >
          Downgrade
        </button>
      )}
    </div>
  )
}

function SpecRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 font-mono text-[12px]">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${highlight ? 'text-warning' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function SubscriptionPlans() {
  const [confirmPlan, setConfirmPlan] = useState<SubscriptionPlan | null>(null)

  const handleConfirm = () => {
    if (!confirmPlan) return
    const isUpgrade = confirmPlan.tier > CURRENT_TIER
    toast.success(
      isUpgrade
        ? `Upgraded to ${confirmPlan.name} — changes take effect immediately.`
        : `Downgraded to ${confirmPlan.name} — takes effect next billing cycle.`,
    )
    setConfirmPlan(null)
  }

  const isFreeTrial = DEMO_USER_STATE === 'free_trial'

  return (
    <div className="space-y-8">
      <AlertBanners />

      {isFreeTrial ? (
        /* Free trial: credit card + choose a plan */
        <div>
          <SectionTitle title="Free Credits" />
          <FreeCreditBanner />
        </div>
      ) : (
        /* Active plan banner */
        <div>
          <SectionTitle title="Active Plan" />
          <ActivePlanBanner />
        </div>
      )}

      {/* All plans grid */}
      <div>
        <SectionTitle title={isFreeTrial ? 'Choose a Plan' : 'All Plans'} count="4 tiers" />
        <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onSwitch={setConfirmPlan} freeTrial={isFreeTrial} />
          ))}
        </div>
      </div>

      {/* Shared confirm dialog */}
      <AlertDialog open={!!confirmPlan} onOpenChange={(open) => !open && setConfirmPlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmPlan && confirmPlan.tier > CURRENT_TIER ? 'Upgrade plan' : 'Downgrade plan'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmPlan && confirmPlan.tier > CURRENT_TIER
                ? `Switch to ${confirmPlan.name} ($${confirmPlan.priceMonthly}/mo). Your new quota and concurrency limits take effect immediately. Prorated charges apply.`
                : `Switch to ${confirmPlan?.name} ($${confirmPlan?.priceMonthly}/mo). The change takes effect at the start of your next billing cycle. Unused quota does not carry over.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
