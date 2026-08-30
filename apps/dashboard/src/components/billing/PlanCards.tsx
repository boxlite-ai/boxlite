/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, Plan } from '@/billing-api'
import { AsciiButton, BRAND } from '@/components/ascii'
import { planCardCta } from '@/components/billing/planChange'
import { Skeleton } from '@/components/ui/skeleton'
import { RoutePath } from '@/enums/RoutePath'
import { formatWholeDollars } from '@/lib/utils'
import { generatePath, useNavigate } from 'react-router-dom'

const CUSTOM_PLAN_CONTACT_URL =
  'mailto:sales@boxlite.ai?subject=Custom%20Plan%20Inquiry&body=Hi%20BoxLite%20Team%2C%0A%0AI%27m%20interested%20in%20a%20custom%20plan%20and%20would%20like%20to%20learn%20more%20about%20your%20options.%0A%0AHere%27s%20some%20context%3A%0A%0A-%20Your%20use%20case%3A%20%0A-%20Current%20technology%3A%20%0A-%20Requirements%3A%20%0A-%20Typical%20box%20size%3A%20%0A-%20Peak%20concurrent%20boxes%3A%20%0A%0AThanks.'

/**
 * Plan catalogue as a card grid. Every value comes from `Plan` — price,
 * included quota, and the concurrency ceiling — the catalog's own sellable
 * attributes, not a resource-ceiling ladder.
 */

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 font-mono text-[12px]">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/** PR 829's cosmetic tier label and quota leverage, derived from catalog order and money. */
export function planCardDisplay(plan: Plan, catalogIndex: number): { tierLabel: string; leverage: string } {
  const leverage =
    plan.priceMonthlyCents && plan.includedQuotaCents
      ? `${(Math.floor((plan.includedQuotaCents / plan.priceMonthlyCents) * 100) / 100)
          .toFixed(2)
          .replace(/0+$/, '')
          .replace(/\.$/, '')}×`
      : '—'

  return { tierLabel: `T${catalogIndex + 1}`, leverage }
}

function PlanCard({
  plan,
  organizationPlan,
  currentPriceCents,
  catalogIndex,
  onSwitch,
}: {
  plan: Plan
  organizationPlan?: OrganizationPlan | null
  currentPriceCents: number | null
  catalogIndex: number
  onSwitch: (plan: Plan) => void
}) {
  const cta = planCardCta({ plan, organizationPlan, currentPriceCents })
  const isActive = cta.kind === 'current'
  const display = planCardDisplay(plan, catalogIndex)

  return (
    <div
      className={`flex flex-col border bg-card px-[22px] py-5 transition-transform hover:-translate-y-0.5 ${
        isActive ? 'border-brand/60' : 'border-border hover:border-brand/40'
      }`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> {display.tierLabel} · {plan.name}
        </span>
        {isActive && (
          <span className="bg-foreground px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-background">
            current
          </span>
        )}
        {/* Outlined, not filled: this plan is coming, not active — the same
            distinction CustomPlanCard's "by request" badge draws. */}
        {cta.kind === 'scheduled' && (
          <span className="border border-brand/30 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-brand">
            scheduled
          </span>
        )}
      </div>

      <div className="mb-4">
        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {plan.priceMonthlyCents != null ? `${formatWholeDollars(plan.priceMonthlyCents)}/mo` : 'Custom'}
        </span>
      </div>

      <div className="mb-5 flex-1 divide-y divide-border/40">
        <SpecRow
          label="Quota"
          value={plan.includedQuotaCents != null ? formatWholeDollars(plan.includedQuotaCents) : 'Unlimited'}
        />
        <SpecRow label="Leverage" value={display.leverage} />
        <SpecRow
          label="Concurrency"
          value={plan.concurrencyLimit != null ? `${plan.concurrencyLimit} boxes` : 'Unlimited'}
        />
      </div>

      {cta.disabled ? (
        <AsciiButton disabled className="w-full text-muted-foreground">
          {cta.label}
        </AsciiButton>
      ) : (
        <AsciiButton
          variant={cta.kind === 'upgrade' ? 'primary' : 'secondary'}
          className="w-full"
          onClick={() => onSwitch(plan)}
        >
          {cta.label}
        </AsciiButton>
      )}
    </div>
  )
}

/**
 * The open-ended plan belongs beside the fixed catalogue, but its dashed
 * border makes clear that its limits and price are scoped rather than preset.
 */
export function CustomPlanCard({ catalogIndex = 3 }: { catalogIndex?: number }) {
  return (
    <div className="flex flex-col border border-dashed border-brand/50 bg-card px-[22px] py-5 transition-colors hover:border-brand">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> T{catalogIndex + 1} · Custom
        </span>
        <span className="border border-brand/30 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-brand">
          by request
        </span>
      </div>

      <div className="mb-4">
        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight text-foreground">Custom</span>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          Talk with sales about a plan for your workload.
        </p>
      </div>

      <div className="mb-5 flex-1 divide-y divide-border/40">
        <SpecRow label="Quota" value="—" />
        <SpecRow label="Leverage" value="—" />
        <SpecRow label="Concurrency" value="—" />
      </div>

      <a
        href={CUSTOM_PLAN_CONTACT_URL}
        className="inline-flex w-full items-center justify-center border border-brand/40 px-4 py-2 font-mono text-[12px] text-foreground transition-colors hover:border-brand hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        Contact sales →
      </a>
    </div>
  )
}

/** Loading state shaped like the grid it replaces. */
export function PlanCardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 border border-border bg-card px-[22px] py-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-[132px] w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

export function PlanCards({ plans, organizationPlan }: { plans: Plan[]; organizationPlan?: OrganizationPlan | null }) {
  const navigate = useNavigate()
  // A lapsed subscription still names its old plan, but that plan no longer
  // prices anything — planCardCta ignores it too, and the two must agree or a
  // card reads "Downgrade" for a move the confirmation page calls "Subscribe".
  const currentPlanId = organizationPlan?.status === 'canceled' ? undefined : organizationPlan?.planId
  // A plan not in this (self-serve-only) catalog is a managed/custom deal —
  // there is no price to compare against, so every self-serve plan reads as
  // an upgrade. The confirmation page says so, and the server is the one that
  // actually knows and will refuse a self-serve switch away from managed billing.
  const currentPriceCents = plans.find((plan) => plan.id === currentPlanId)?.priceMonthlyCents ?? null

  return (
    <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
      {plans.map((plan, catalogIndex) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          organizationPlan={organizationPlan}
          currentPriceCents={currentPriceCents}
          catalogIndex={catalogIndex}
          onSwitch={(target) => navigate(generatePath(RoutePath.BILLING_PLAN_CHANGE, { planId: target.id }))}
        />
      ))}
      <CustomPlanCard catalogIndex={plans.length} />
    </div>
  )
}
