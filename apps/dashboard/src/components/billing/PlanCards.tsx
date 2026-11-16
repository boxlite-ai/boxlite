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

// The four cards are read across, not one at a time, so their bands are fixed:
// the badge row holds its height with or without a badge, and the price band
// holds the tallest of them (a price, or a price above a line of prose). Left
// to `flex-1` the leftover height collected in the middle of the short cards
// instead, so no two rows lined up and each card carried ~100px of nothing.
const CARD_BADGE_ROW = 'mb-3 flex h-[18px] items-center justify-between gap-3'
const CARD_BADGE =
  'border border-border px-1.5 py-0.5 font-sans text-label uppercase tracking-[1px] text-muted-foreground'
const CARD_PRICE_BAND = 'mb-3 flex min-h-[64px] flex-col justify-start'

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 font-sans text-meta">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/** Uses the current subscription to choose a disabled, scheduled, upgrade or downgrade action. */
function PlanCard({
  plan,
  organizationPlan,
  currentPriceCents,
  onSwitch,
}: {
  plan: Plan
  organizationPlan?: OrganizationPlan | null
  currentPriceCents: number | null
  onSwitch: (plan: Plan) => void
}) {
  const cta = planCardCta({ plan, organizationPlan, currentPriceCents })
  const isActive = cta.kind === 'current'

  return (
    <div
      className={`flex flex-col border bg-card px-[22px] py-5 transition-transform hover:-translate-y-0.5 ${
        isActive ? 'border-border-selected' : 'border-border hover:border-border-hover'
      }`}
    >
      <div className={CARD_BADGE_ROW}>
        <span className="font-sans text-label uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> {plan.name}
        </span>
        {isActive && <span className={CARD_BADGE}>current</span>}
        {cta.kind === 'scheduled' && <span className={CARD_BADGE}>scheduled</span>}
      </div>

      <div className={CARD_PRICE_BAND}>
        <span className="font-mono text-page font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {plan.priceMonthlyCents != null ? `${formatWholeDollars(plan.priceMonthlyCents)}/mo` : 'Custom'}
        </span>
      </div>

      <div className="mb-5 divide-y divide-border">
        <SpecRow
          label="Quota"
          value={plan.includedQuotaCents != null ? formatWholeDollars(plan.includedQuotaCents) : 'Unlimited'}
        />
        <SpecRow
          label="Concurrency"
          value={plan.concurrencyLimit != null ? `${plan.concurrencyLimit} boxes` : 'Unlimited'}
        />
      </div>

      {/* Switching plans is one lateral choice, so every card's action carries
          the same weight — an upgrade is not a different kind of act from a
          downgrade. */}
      <div className="mt-auto">
        {cta.disabled ? (
          <AsciiButton disabled className="w-full text-muted-foreground">
            {cta.label}
          </AsciiButton>
        ) : (
          <AsciiButton className="w-full" onClick={() => onSwitch(plan)}>
            {cta.label}
          </AsciiButton>
        )}
      </div>
    </div>
  )
}

/**
 * The open-ended plan belongs beside the fixed catalogue, and reads like one:
 * a plain border, with "by request" carrying the difference. A dashed border
 * would have said something else — elsewhere in the console dashes mean an
 * isolation boundary or a placeholder.
 */
export function CustomPlanCard() {
  return (
    <div className="flex flex-col border border-border bg-card px-[22px] py-5 transition-colors hover:border-border-hover">
      <div className={CARD_BADGE_ROW}>
        <span className="font-sans text-label uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Custom
        </span>
        <span className={CARD_BADGE}>by request</span>
      </div>

      <div className={CARD_PRICE_BAND}>
        <span className="font-sans text-page font-semibold leading-none tracking-tight text-foreground">Custom</span>
        <p className="mt-2 font-sans text-meta leading-relaxed text-muted-foreground">
          Talk with sales about your workload.
        </p>
      </div>

      <div className="mb-5 divide-y divide-border">
        <SpecRow label="Quota" value="—" />
        <SpecRow label="Concurrency" value="—" />
      </div>

      <a
        href={CUSTOM_PLAN_CONTACT_URL}
        className="mt-auto inline-flex w-full items-center justify-center border border-border px-4 py-2 font-sans text-meta text-foreground transition-colors hover:border-border-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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

/** Compares self-serve prices against the active plan and routes changes through confirmation. */
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
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          organizationPlan={organizationPlan}
          currentPriceCents={currentPriceCents}
          onSwitch={(target) => navigate(generatePath(RoutePath.BILLING_PLAN_CHANGE, { planId: target.id }))}
        />
      ))}
      <CustomPlanCard />
    </div>
  )
}
