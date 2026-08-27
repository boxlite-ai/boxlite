/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, OrganizationWallet, Plan } from '@/billing-api'
import { AsciiButton, BRAND, Metric, Panel, PanelNote, SectionTitle, SegmentedBar } from '@/components/ascii'
import { ScheduledChange, scheduledChange } from '@/components/billing/planChange'
import { Spinner } from '@/components/ui/spinner'
import { useKeepPlanMutation } from '@/hooks/mutations/useKeepPlanMutation'
import { useUsagePricesQuery } from '@/hooks/queries/useUsagePricesQuery'
import { formatPriceCents } from '@/lib/box-price'
import { handleApiError } from '@/lib/error-handling'
import { formatAmount, formatWholeDollars } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * How this organization is being billed right now, and the figures that follow
 * from it.
 *
 * Three modes, because "no subscription" is not one state. An account on free
 * credits and an account paying its own way both lack a plan, but they are
 * reading for different numbers — how much of the grant is left, versus what
 * the wallet is funding. Rendering both as the word "No plan" told neither of
 * them anything, and labelled the panel "Active plan" while saying there wasn't
 * one.
 */
export type BillingMode =
  | { kind: 'plan'; plan: OrganizationPlan }
  /** No subscription, still spending a grant. Credit is what they watch. */
  | { kind: 'free-trial'; grantedCents: number; remainingCents: number }
  /** No subscription and no grant: usage is charged to the wallet, per hour. */
  | { kind: 'payg' }

const TITLE: Record<BillingMode['kind'], string> = {
  plan: 'Active Plan',
  'free-trial': 'Free Credits',
  payg: 'Billing',
}

/**
 * A grant that was never issued is not a free trial — `creditGrantedCents` is
 * absent (Commerce does not track one) or zero (tracked, none given). Both read
 * as pay-as-you-go, which is what the account actually is until the grant lands.
 */
export function billingMode(
  wallet: Pick<OrganizationWallet, 'creditGrantedCents' | 'creditRemainingCents'>,
  plan?: OrganizationPlan | null,
): BillingMode {
  if (plan) {
    return { kind: 'plan', plan }
  }
  const grantedCents = wallet.creditGrantedCents ?? 0
  if (grantedCents > 0) {
    return { kind: 'free-trial', grantedCents, remainingCents: wallet.creditRemainingCents ?? 0 }
  }
  return { kind: 'payg' }
}

export function CycleOverview({
  wallet,
  organizationPlan,
  catalogPlan,
  catalogIndex,
  catalog = [],
  organizationId,
  plansAnchorId,
}: {
  wallet: OrganizationWallet
  organizationPlan?: OrganizationPlan | null
  catalogPlan?: Plan
  catalogIndex?: number
  /** The whole catalog, so a queued plan can be named rather than shown as an id. */
  catalog?: Plan[]
  organizationId?: string
  plansAnchorId?: string
}) {
  const mode = billingMode(wallet, organizationPlan)
  const tierLabel = catalogIndex === undefined ? 'Plan' : `T${catalogIndex + 1}`
  const scheduled = scheduledChange({ plan: organizationPlan, catalog })

  return (
    <section>
      <SectionTitle title={TITLE[mode.kind]} />
      <Panel>
        <div className="flex flex-wrap items-center gap-4 px-[22px] py-5">
          <div className="flex items-center gap-3">
            {mode.kind === 'plan' && (
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                <span style={{ color: BRAND }}>▸</span> {tierLabel}
              </span>
            )}
            <span className="font-mono text-[18px] font-semibold tracking-tight text-foreground">
              {mode.kind === 'plan' ? mode.plan.planName : mode.kind === 'free-trial' ? 'Free trial' : 'Pay as you go'}
              <span className="ml-1 animate-pulse text-muted-foreground">▮</span>
            </span>
            {mode.kind === 'plan' && (
              <span className="bg-foreground px-2 py-0.5 font-mono text-[10px] uppercase tracking-[1px] text-background">
                {mode.plan.status}
              </span>
            )}
          </div>
          {mode.kind === 'plan' && catalogPlan?.priceMonthlyCents != null ? (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {formatWholeDollars(catalogPlan.priceMonthlyCents)}/mo
            </span>
          ) : mode.kind !== 'plan' ? (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">no subscription</span>
          ) : null}
        </div>

        {mode.kind === 'plan' ? (
          <PlanFigures plan={mode.plan} wallet={wallet} catalogPlan={catalogPlan} />
        ) : mode.kind === 'free-trial' ? (
          <FreeTrialFigures mode={mode} wallet={wallet} />
        ) : (
          <PaygFigures wallet={wallet} />
        )}

        {mode.kind !== 'plan' && <UnsubscribedNote mode={mode} plansAnchorId={plansAnchorId} />}
        {scheduled && organizationPlan && (
          <ScheduledChangeNote scheduled={scheduled} organizationId={organizationId} planId={organizationPlan.planId} />
        )}
      </Panel>
    </section>
  )
}

/**
 * States what is already queued against this cycle, and offers the way out.
 *
 * Deliberately asymmetric with the plan-change confirmation page: committing a
 * downgrade costs capacity and gets a full page, while keeping the plan you
 * already have restores the status quo, changes nothing today, and can be
 * re-queued from the grid at no cost. So this one commits on a single click.
 */
function ScheduledChangeNote({
  scheduled,
  organizationId,
  planId,
}: {
  scheduled: ScheduledChange
  /** Absent while the organization is still resolving — the note still states what is queued. */
  organizationId?: string
  planId: string
}) {
  const keepPlan = useKeepPlanMutation()

  const handleKeep = async () => {
    if (!organizationId) {
      return
    }
    try {
      const checkoutUrl = await keepPlan.mutateAsync({ organizationId, planId, kind: scheduled.kind })
      if (checkoutUrl) {
        // A stale cancellation can cross its boundary before this click. Commerce
        // then treats keeping the old plan as a fresh subscribe with Checkout.
        window.location.href = checkoutUrl
        return
      }
      toast.success(scheduled.keptLabel)
    } catch (error) {
      handleApiError(error, 'Failed to cancel the scheduled plan change')
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-[22px] py-4">
      <PanelNote>{scheduled.text}</PanelNote>
      {organizationId && (
        <AsciiButton
          disabled={keepPlan.isPending}
          onClick={handleKeep}
          className="inline-flex shrink-0 items-center gap-2"
        >
          {keepPlan.isPending && <Spinner className="size-3.5" />}
          {scheduled.keepLabel}
        </AsciiButton>
      )}
    </div>
  )
}

const FIGURES = 'grid grid-cols-2 gap-5 border-t border-border px-[22px] py-5 sm:flex sm:flex-row sm:gap-14'

function PlanFigures({
  plan,
  wallet,
  catalogPlan,
}: {
  plan: OrganizationPlan
  wallet: OrganizationWallet
  catalogPlan?: Plan
}) {
  return (
    <div className={FIGURES}>
      <Metric
        label="Subscription"
        value={plan.planName}
        sub={
          catalogPlan?.priceMonthlyCents != null ? `${formatWholeDollars(catalogPlan.priceMonthlyCents)}/mo` : undefined
        }
      />
      <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} />
      <Metric
        label="Quota consumed"
        value={formatAmount(plan.quotaConsumedCents)}
        sub={plan.includedQuotaCents == null ? 'unlimited quota' : `/ ${formatAmount(plan.includedQuotaCents)}`}
      />
    </div>
  )
}

function FreeTrialFigures({
  mode,
  wallet,
}: {
  mode: Extract<BillingMode, { kind: 'free-trial' }>
  wallet: OrganizationWallet
}) {
  const spentCents = Math.max(0, mode.grantedCents - mode.remainingCents)
  return (
    <>
      <div className={FIGURES}>
        <Metric
          label="Free credits left"
          value={formatAmount(mode.remainingCents)}
          sub={`of ${formatAmount(mode.grantedCents)} granted`}
        />
        <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} sub="used after credits" />
      </div>
      <div className="border-t border-border px-[22px] py-4">
        <div className="flex items-center gap-4 font-mono text-[12px]">
          <span className="w-[100px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">Credits used</span>
          <span className="w-[140px] shrink-0 tabular-nums text-foreground">
            {formatAmount(spentCents)} / {formatAmount(mode.grantedCents)}
          </span>
          {/* Fills as the grant is spent — the bar's warning colours only read
              correctly when the filled part is the part that is gone. */}
          <SegmentedBar used={spentCents} limit={mode.grantedCents} />
        </div>
      </div>
    </>
  )
}

function PaygFigures({ wallet }: { wallet: OrganizationWallet }) {
  // Commerce's ongoing balance is the wallet minus usage it has metered but not
  // yet invoiced, so the gap is exactly what this period has drawn. Naming it
  // "this month" would be a guess: without a subscription there is no cycle.
  const uninvoicedCents = Math.max(0, wallet.balanceCents - wallet.ongoingBalanceCents)
  return (
    <div className={FIGURES}>
      <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} sub="funds every box" />
      {uninvoicedCents > 0 && (
        <Metric label="Uninvoiced usage" value={formatAmount(uninvoicedCents)} sub="drawn, not yet billed" />
      )}
    </div>
  )
}

/** Says what happens next, and points at the grid that changes it. */
function UnsubscribedNote({
  mode,
  plansAnchorId,
}: {
  mode: Extract<BillingMode, { kind: 'free-trial' | 'payg' }>
  plansAnchorId?: string
}) {
  const { data: prices } = useUsagePricesQuery()
  const cpu = prices?.prices.find((price) => price.code === 'cpu')
  const fromRate = cpu ? ` — from ${formatPriceCents(cpu.unitPriceCents, 6)}/vCPU·hr` : ''
  const howItIsCharged =
    mode.kind === 'free-trial'
      ? 'Usage draws on your free credits first, then on the wallet.'
      : `Usage is charged to your wallet at the published rates${fromRate}.`

  return (
    <div className="border-t border-border px-[22px] py-4">
      <PanelNote>
        {howItIsCharged} A plan adds included quota at a lower effective rate.
        {plansAnchorId && (
          <>
            {' '}
            <a href={`#${plansAnchorId}`} className="text-foreground underline underline-offset-2">
              Compare plans ↓
            </a>
          </>
        )}
      </PanelNote>
    </div>
  )
}
