/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, Plan } from '@/billing-api'
import { AsciiButton, BRAND } from '@/components/ascii'
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
import { Skeleton } from '@/components/ui/skeleton'
import { useDowngradePlanMutation } from '@/hooks/mutations/useDowngradePlanMutation'
import { useUpgradePlanMutation } from '@/hooks/mutations/useUpgradePlanMutation'
import { handleApiError } from '@/lib/error-handling'
import { formatWholeDollars } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'

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

/** With no plan yet, $0/mo is the floor — every real plan is an upgrade. */
function isUpgradeTo(plan: Plan, currentPriceCents: number | null): boolean {
  return (plan.priceMonthlyCents ?? 0) > (currentPriceCents ?? 0)
}

function PlanCard({
  plan,
  currentPlanId,
  currentPriceCents,
  onSwitch,
  pending,
}: {
  plan: Plan
  currentPlanId?: string
  currentPriceCents: number | null
  onSwitch: (plan: Plan) => void
  pending: boolean
}) {
  const isActive = plan.id === currentPlanId
  const isUpgrade = isUpgradeTo(plan, currentPriceCents)

  return (
    <div
      className={`flex flex-col border bg-card px-[22px] py-5 transition-transform hover:-translate-y-0.5 ${
        isActive ? 'border-brand/60' : 'border-border hover:border-brand/40'
      }`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> {plan.name}
        </span>
        {isActive && (
          <span className="bg-foreground px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-background">
            current
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
          label="Included quota"
          value={plan.includedQuotaCents != null ? formatWholeDollars(plan.includedQuotaCents) : 'Unlimited'}
        />
        <SpecRow
          label="Concurrency limit"
          value={plan.concurrencyLimit != null ? `${plan.concurrencyLimit} boxes` : 'No limit'}
        />
      </div>

      {isActive ? (
        <AsciiButton disabled className="w-full text-muted-foreground">
          Current plan
        </AsciiButton>
      ) : isUpgrade ? (
        <AsciiButton variant="primary" className="w-full" disabled={pending} onClick={() => onSwitch(plan)}>
          Upgrade →
        </AsciiButton>
      ) : (
        <AsciiButton className="w-full" disabled={pending} onClick={() => onSwitch(plan)}>
          Downgrade
        </AsciiButton>
      )}
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

/**
 * Enterprise sits below the grid rather than in it: the catalog's own
 * non-self-serve entry is filtered out of `plans` before it ever reaches
 * here, so this stays the fixed contact-sales row it always was.
 */
export function EnterpriseRow() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-foreground">
          Custom limits and compliance review. Contact sales at{' '}
          <a href="mailto:sales@boxlite.ai" className="underline hover:text-foreground">
            sales@boxlite.ai
          </a>
          .
        </span>
      </div>
      <a
        href="mailto:sales@boxlite.ai?subject=Custom%20Plan%20Inquiry&body=Hi%20BoxLite%20Team%2C%0A%0AI%27m%20interested%20in%20a%20custom%20plan%20and%20would%20like%20to%20learn%20more%20about%20your%20options.%0A%0AHere%27s%20some%20context%3A%0A%0A-%20Your%20use%20case%3A%20%0A-%20Current%20technology%3A%20%0A-%20Requirements%3A%20%0A-%20Typical%20box%20size%3A%20%0A-%20Peak%20concurrent%20boxes%3A%20%0A%0AThanks."
        className="border border-border px-4 py-2 font-mono text-[12px] text-foreground transition-colors hover:border-brand"
      >
        Contact sales →
      </a>
    </div>
  )
}

export function PlanCards({
  plans,
  organizationPlan,
  organizationId,
}: {
  plans: Plan[]
  organizationPlan?: OrganizationPlan | null
  organizationId: string
}) {
  const [confirmPlan, setConfirmPlan] = useState<Plan | null>(null)
  const upgradePlan = useUpgradePlanMutation()
  const downgradePlan = useDowngradePlanMutation()
  const pending = upgradePlan.isPending || downgradePlan.isPending
  const currentPlanId = organizationPlan?.planId
  // A plan not in this (self-serve-only) catalog is a managed/custom deal —
  // there is no price to compare against, so every self-serve plan reads as
  // an upgrade. The server is the one that actually knows and will refuse a
  // self-serve switch away from managed billing with its own error.
  const currentPriceCents = plans.find((plan) => plan.id === currentPlanId)?.priceMonthlyCents ?? null

  const isUpgrade = !!confirmPlan && isUpgradeTo(confirmPlan, currentPriceCents)

  const handleConfirm = async () => {
    if (!confirmPlan) {
      return
    }
    const target = confirmPlan
    const upgrading = isUpgradeTo(confirmPlan, currentPriceCents)
    setConfirmPlan(null)
    try {
      if (upgrading) {
        const checkoutUrl = await upgradePlan.mutateAsync({ organizationId, planId: target.id })
        if (checkoutUrl) {
          window.location.href = checkoutUrl
          return
        }
        toast.success('Plan upgraded successfully')
      } else {
        await downgradePlan.mutateAsync({ organizationId, planId: target.id })
        toast.success('Plan will change at the next billing cycle')
      }
    } catch (error) {
      handleApiError(error, `Failed to ${upgrading ? 'upgrade' : 'downgrade'} organization plan`)
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            currentPlanId={currentPlanId}
            currentPriceCents={currentPriceCents}
            onSwitch={setConfirmPlan}
            pending={pending}
          />
        ))}
      </div>

      <AlertDialog open={!!confirmPlan} onOpenChange={(open) => !open && setConfirmPlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isUpgrade ? 'Upgrade plan' : 'Downgrade plan'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isUpgrade
                ? `Switch to ${confirmPlan?.name} now. An existing subscription is charged the prorated difference immediately; a first subscribe continues to a secure Stripe checkout to confirm payment.`
                : `Switch to ${confirmPlan?.name} at the next billing cycle. Your current plan's quota stays available until then.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
