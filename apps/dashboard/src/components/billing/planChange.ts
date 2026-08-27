/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, OrganizationWallet, Plan } from '@/billing-api'
import { formatAmount, formatWholeDollars } from '@/lib/utils'
import { format } from 'date-fns'

/**
 * What kind of move this is, for the words on the page. Separate from `action`
 * because the two do not line up: a resubscribe and a switch away from a
 * negotiated deal both run the *upgrade* endpoint whatever their price says.
 */
export type PlanChangeDirection = 'upgrade' | 'downgrade' | 'subscribe' | 'unknown'

export interface PlanComparison {
  label: string
  from: string
  to: string
}

export interface PlanChangeNote {
  tone: 'info' | 'warn'
  text: string
}

/** Why Confirm cannot run. `redirect` cases the caller turns into a <Navigate replace>. */
export type PlanChangeBlock =
  | { kind: 'not-in-catalog'; redirect: true }
  | { kind: 'same-plan'; redirect: true }
  | { kind: 'already-queued'; redirect: false; text: string }

/**
 * Everything the confirmation states, as plain values — pure in
 * (planId, catalog, plan, wallet) so the subscribe/canceled/queued/unlimited
 * branching is testable without a DOM.
 */
export interface PlanChangeSummary {
  /** The catalog row for `planId`, or null when it names nothing switchable. */
  target: Plan | null
  direction: PlanChangeDirection
  /** Which mutation Confirm runs. Not derivable from `direction`. */
  action: 'upgrade' | 'downgrade'
  title: string
  confirmLabel: string
  /** Price, included quota and concurrency, already formatted for display. */
  comparisons: PlanComparison[]
  /** When the change lands and what it costs. */
  effect: string
  /** Downgrade only: the quota this cycle already paid for. */
  quotaNote: string | null
  /** The wallet that absorbs usage beyond the included quota. */
  walletNote: string | null
  /** Conditions worth stating before confirming — a negotiated plan, a queued change. */
  caveats: PlanChangeNote[]
  blocked: PlanChangeBlock | null
}

/** With no plan yet, $0/mo is the floor — every real plan is an upgrade. */
export function isUpgradeTo(plan: Plan, currentPriceCents: number | null): boolean {
  return (plan.priceMonthlyCents ?? 0) > (currentPriceCents ?? 0)
}

/** What a cycle will actually roll into. */
export type QueuedChange = { kind: 'cancel' } | { kind: 'downgrade'; planId: string }

/**
 * A scheduled cancellation outranks a queued downgrade: the plan id stays set
 * behind it, but that change never happens. A cycle that already lapsed
 * (`status: 'canceled'`) rolls into nothing at all.
 *
 * Every surface that states, offers, or blocks a queued change reads this.
 * Four hand-written copies of the rule drifted apart once already, which left
 * an enabled plan card pointing at a confirmation page with no button on it.
 */
export function queuedChange(plan: OrganizationPlan | null | undefined): QueuedChange | null {
  if (!plan || plan.status === 'canceled') {
    return null
  }
  if (plan.cancelAtPeriodEnd) {
    return { kind: 'cancel' }
  }
  return plan.pendingPlanId ? { kind: 'downgrade', planId: plan.pendingPlanId } : null
}

/** `null` price means negotiated outside the catalog, not free. */
function price(plan: Plan | undefined, fallback: string): string {
  if (!plan) {
    return fallback
  }
  return plan.priceMonthlyCents != null ? `${formatWholeDollars(plan.priceMonthlyCents)}/mo` : 'Custom'
}

/** `null` quota/concurrency means unlimited, not zero. */
function quota(plan: Plan | undefined, fallback: string): string {
  if (!plan) {
    return fallback
  }
  return plan.includedQuotaCents != null ? formatWholeDollars(plan.includedQuotaCents) : 'Unlimited'
}

function concurrency(plan: Plan | undefined, fallback: string): string {
  if (!plan) {
    return fallback
  }
  return plan.concurrencyLimit != null ? `${plan.concurrencyLimit} boxes` : 'Unlimited'
}

/** A plan id is not user-facing copy — resolve it, and only fall back when the catalog cannot. */
function planName(planId: string, catalog: Plan[]): string {
  return catalog.find((plan) => plan.id === planId)?.name ?? planId
}

export function planChangeSummary({
  planId,
  catalog,
  plan,
  wallet,
}: {
  planId: string
  /** The public catalog as served; `selfServe` is enforced here, not by the caller. */
  catalog: Plan[]
  /** `null` means no live subscription. The caller waits for the query to succeed first. */
  plan: OrganizationPlan | null
  wallet?: OrganizationWallet
}): PlanChangeSummary {
  const target = catalog.find((entry) => entry.id === planId && entry.selfServe) ?? null
  // The catalog row for the live plan. Missing means a negotiated deal that
  // never appears in the public catalog (Plan.ts), not a loading gap.
  const current = plan ? catalog.find((entry) => entry.id === plan.planId) : undefined
  const rollDay = plan ? format(plan.cycleTo, 'MMM d, yyyy') : null
  // A canceled subscription has no next cycle to roll into, so nothing can be
  // "queued" against it — it restarts instead (OrganizationPlan.ts:20-25).
  const ended = plan?.status === 'canceled'

  const direction = directionFor({ target, plan, current, ended })
  // Only a plain downgrade on a live cycle defers; everything else takes the
  // upgrade endpoint, which applies in place or hands back a Checkout URL.
  const action = direction === 'downgrade' ? 'downgrade' : 'upgrade'
  const noPlanLabel = 'No subscription'

  return {
    target,
    direction,
    action,
    title: { upgrade: 'Upgrade plan', downgrade: 'Downgrade plan', subscribe: 'Subscribe', unknown: 'Change plan' }[
      direction
    ],
    confirmLabel: {
      upgrade: 'Confirm upgrade',
      downgrade: 'Confirm downgrade',
      subscribe: 'Subscribe',
      unknown: 'Confirm change',
    }[direction],
    comparisons: [
      { label: 'Price', from: price(current, plan ? 'Custom' : noPlanLabel), to: price(target ?? undefined, '—') },
      {
        label: 'Included quota',
        from: quota(current, plan ? 'Custom' : noPlanLabel),
        to: quota(target ?? undefined, '—'),
      },
      {
        label: 'Concurrency',
        from: concurrency(current, plan ? 'Custom' : noPlanLabel),
        to: concurrency(target ?? undefined, '—'),
      },
    ],
    effect: effectFor({ direction, targetName: target?.name ?? planId, ended, rollDay }),
    quotaNote:
      direction === 'downgrade' && plan?.quotaRemainingCents != null && rollDay
        ? `You keep ${formatAmount(plan.quotaRemainingCents)} of unused quota until ${rollDay}.`
        : null,
    walletNote: wallet
      ? `Usage beyond the included quota draws on the wallet, which holds ${formatAmount(wallet.balanceCents)}.`
      : null,
    caveats: caveatsFor({ planId, plan, current, catalog, rollDay }),
    blocked: blockFor({ planId, target, plan, ended, rollDay }),
  }
}

function directionFor({
  target,
  plan,
  current,
  ended,
}: {
  target: Plan | null
  plan: OrganizationPlan | null
  current: Plan | undefined
  ended: boolean
}): PlanChangeDirection {
  // Nothing live to change from — a first subscribe, or a restart after the
  // paid cycle ran out. Either way there is no cycle to defer into.
  if (!plan || ended) {
    return 'subscribe'
  }
  // No catalog row for the live plan, or none for the target: no two prices to
  // compare, so claiming a direction would be a guess.
  if (!current || !target) {
    return 'unknown'
  }
  return isUpgradeTo(target, current.priceMonthlyCents) ? 'upgrade' : 'downgrade'
}

/**
 * The sentence read immediately before money moves. The live-subscription cases
 * carry over the wording the confirm dialog already shipped; the subscribe and
 * resubscribe cases are new, and say plainly that confirming may leave the app.
 */
function effectFor({
  direction,
  targetName,
  ended,
  rollDay,
}: {
  direction: PlanChangeDirection
  targetName: string
  ended: boolean
  rollDay: string | null
}): string {
  if (direction === 'subscribe') {
    return ended
      ? `Your subscription has ended, so this starts a new one on ${targetName}. You may be sent to Stripe to confirm payment.`
      : `Starts as soon as payment is confirmed. Continuing opens a secure Stripe checkout to enter your card — you will leave the dashboard.`
  }
  if (direction === 'unknown') {
    return `Switches you to ${targetName}. Because your current plan is negotiated, the terms and any charge are settled by billing rather than shown here.`
  }
  if (direction === 'upgrade') {
    return `Applies immediately. Your subscription is charged the prorated difference today, and ${targetName}'s quota is available right away.`
  }
  return rollDay
    ? `Applies on ${rollDay}, when the current cycle rolls. Nothing is charged today.`
    : `Applies at the next billing cycle. Nothing is charged today.`
}

function caveatsFor({
  planId,
  plan,
  current,
  catalog,
  rollDay,
}: {
  planId: string
  plan: OrganizationPlan | null
  current: Plan | undefined
  catalog: Plan[]
  rollDay: string | null
}): PlanChangeNote[] {
  const caveats: PlanChangeNote[] = []
  // A live plan with no catalog row is a negotiated deal: there is no public
  // price to compare against, and billing refuses the self-serve switch with
  // its own error rather than the dashboard guessing the terms.
  if (plan && !current) {
    caveats.push({
      tone: 'warn',
      text: `${plan.planName} is a negotiated plan, so there is no catalog price to compare against. Switching to a standard plan may be refused — talk to sales first.`,
    })
  }
  const queued = queuedChange(plan)
  if (queued?.kind === 'cancel') {
    caveats.push({
      tone: 'warn',
      text: `Your subscription is set to end${rollDay ? ` on ${rollDay}` : ''}. Confirming replaces that with this change.`,
    })
    // When the queued plan IS the one being viewed, `blocked` already says there
    // is nothing to confirm — "confirming replaces it" beside that contradicts it.
  } else if (queued?.kind === 'downgrade' && queued.planId !== planId) {
    caveats.push({
      tone: 'info',
      text: `A change to ${planName(queued.planId, catalog)} is already queued${
        rollDay ? ` for ${rollDay}` : ''
      }. Confirming replaces it.`,
    })
  }
  return caveats
}

function blockFor({
  planId,
  target,
  plan,
  ended,
  rollDay,
}: {
  planId: string
  target: Plan | null
  plan: OrganizationPlan | null
  ended: boolean
  rollDay: string | null
}): PlanChangeBlock | null {
  if (!target) {
    return { kind: 'not-in-catalog', redirect: true }
  }
  // A canceled subscription still names its old plan, and resubscribing to it
  // is a real change — only a live plan makes this a no-op.
  if (plan && !ended && plan.planId === planId) {
    return { kind: 'same-plan', redirect: true }
  }
  // Only a downgrade that is genuinely still coming leaves nothing to confirm.
  const queued = queuedChange(plan)
  if (queued?.kind === 'downgrade' && queued.planId === planId) {
    return {
      kind: 'already-queued',
      redirect: false,
      text: `${target.name} is already scheduled to start${rollDay ? ` on ${rollDay}` : ''}. There is nothing to confirm.`,
    }
  }
  return null
}

/** A change already queued against the live cycle, and the control that discards it. */
export interface ScheduledChange {
  kind: 'downgrade' | 'cancel'
  /** What the panel states. */
  text: string
  /** Label for the control that discards it — names the plan being kept. */
  keepLabel: string
  /** Confirmation once it is discarded. Stated outright rather than derived from keepLabel. */
  keptLabel: string
}

/** The queued change as the Active Plan panel states it, with the control that discards it. */
export function scheduledChange({
  plan,
  catalog,
}: {
  plan: OrganizationPlan | null | undefined
  catalog: Plan[]
}): ScheduledChange | null {
  const queued = queuedChange(plan)
  if (!plan || !queued) {
    return null
  }
  const on = format(plan.cycleTo, 'MMM d, yyyy')
  const keeps = `${plan.planName}'s quota and concurrency stay yours until then.`
  const keepLabel = `Keep ${plan.planName}`
  const keptLabel = `Staying on ${plan.planName}`

  if (queued.kind === 'cancel') {
    return { kind: 'cancel', text: `Your subscription ends ${on} — ${keeps}`, keepLabel, keptLabel }
  }
  // An id is not user-facing copy. A queued plan the public catalog cannot
  // name is a negotiated one; say what happens without inventing a name.
  const named = catalog.find((entry) => entry.id === queued.planId)
  return {
    kind: 'downgrade',
    text: named
      ? `Your downgrade to ${named.name} is scheduled for ${on} — ${keeps}`
      : `Your plan changes on ${on} — ${keeps}`,
    keepLabel,
    keptLabel,
  }
}

/** What a plan's card offers. `disabled` covers both "already yours" and "already queued". */
export type PlanCardCta =
  | { kind: 'current'; label: string; disabled: true }
  | { kind: 'scheduled'; label: string; disabled: true }
  | { kind: 'upgrade'; label: string; disabled: false }
  | { kind: 'downgrade'; label: string; disabled: false }

export function planCardCta({
  plan,
  organizationPlan,
  currentPriceCents,
}: {
  plan: Plan
  organizationPlan: OrganizationPlan | null | undefined
  currentPriceCents: number | null
}): PlanCardCta {
  // A canceled subscription still names its old plan, but that plan is no
  // longer yours to be "current" on — resubscribing to it is a real action,
  // and the confirmation page accepts it.
  const live = organizationPlan && organizationPlan.status !== 'canceled' ? organizationPlan : null

  if (live?.planId === plan.id) {
    return { kind: 'current', label: 'Current plan', disabled: true }
  }
  const queued = queuedChange(organizationPlan)
  if (live && queued?.kind === 'downgrade' && queued.planId === plan.id) {
    return { kind: 'scheduled', label: `Starts ${format(live.cycleTo, 'MMM d')}`, disabled: true }
  }
  return isUpgradeTo(plan, currentPriceCents)
    ? { kind: 'upgrade', label: 'Upgrade →', disabled: false }
    : { kind: 'downgrade', label: 'Downgrade', disabled: false }
}
