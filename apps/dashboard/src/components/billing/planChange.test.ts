/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, Plan } from '@/billing-api'
import { describe, expect, it } from 'vitest'
import { isUpgradeTo, planCardCta, planChangeSummary, queuedChange, scheduledChange } from './planChange'

const CATALOG: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthlyCents: 1_900,
    includedQuotaCents: 3_000,
    concurrencyLimit: 20,
    selfServe: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyCents: 14_900,
    includedQuotaCents: 25_000,
    concurrencyLimit: 100,
    selfServe: true,
  },
  {
    id: 'max',
    name: 'Max',
    priceMonthlyCents: 49_900,
    includedQuotaCents: 90_000,
    concurrencyLimit: 1_000,
    selfServe: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthlyCents: null,
    includedQuotaCents: null,
    concurrencyLimit: null,
    selfServe: false,
  },
]

const LIVE_PRO: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date(Date.UTC(2026, 7, 5)),
  cycleTo: new Date(Date.UTC(2026, 8, 5)),
  includedQuotaCents: 25_000,
  quotaConsumedCents: 6_250,
  quotaRemainingCents: 18_750,
}

const summarize = (
  planId: string,
  plan: OrganizationPlan | null,
  wallet?: Parameters<typeof planChangeSummary>[0]['wallet'],
) => planChangeSummary({ planId, catalog: CATALOG, plan, wallet })

const catalogEntry = (planId: string): Plan => {
  const entry = CATALOG.find((plan) => plan.id === planId)
  if (!entry) {
    throw new Error(`no catalog entry for ${planId}`)
  }
  return entry
}

const cta = (planId: string, plan: OrganizationPlan | null) =>
  planCardCta({
    plan: catalogEntry(planId),
    organizationPlan: plan,
    currentPriceCents: plan ? (CATALOG.find((entry) => entry.id === plan.planId)?.priceMonthlyCents ?? null) : null,
  })

describe('isUpgradeTo', () => {
  it('treats an unpriced current plan as the $0 floor', () => {
    expect(isUpgradeTo(CATALOG[0], null)).toBe(true)
    expect(isUpgradeTo(CATALOG[1], 14_900)).toBe(false)
  })
})

describe('direction and the endpoint it maps to', () => {
  it('reads a costlier plan as an upgrade that applies in place', () => {
    const summary = summarize('max', LIVE_PRO)

    expect(summary.direction).toBe('upgrade')
    expect(summary.action).toBe('upgrade')
    expect(summary.title).toBe('Upgrade plan')
  })

  it('reads a cheaper plan as a downgrade that defers', () => {
    const summary = summarize('starter', LIVE_PRO)

    expect(summary.direction).toBe('downgrade')
    expect(summary.action).toBe('downgrade')
  })

  it('calls a first subscribe a subscribe, not an upgrade from zero', () => {
    const summary = summarize('pro', null)

    expect(summary.direction).toBe('subscribe')
    expect(summary.action).toBe('upgrade')
    expect(summary.confirmLabel).toBe('Subscribe')
  })

  // A canceled subscription has no next cycle, so routing a cheaper plan to the
  // downgrade endpoint would promise a roll that never happens.
  it('treats a cheaper plan after cancellation as a resubscribe, not a downgrade', () => {
    const summary = summarize('starter', { ...LIVE_PRO, status: 'canceled' })

    expect(summary.direction).toBe('subscribe')
    expect(summary.action).toBe('upgrade')
    expect(summary.effect).toContain('has ended')
  })

  it('claims no direction when the live plan is off-catalog', () => {
    const managed: OrganizationPlan = { ...LIVE_PRO, planId: 'managed', planName: 'Managed' }
    const summary = summarize('pro', managed)

    expect(summary.direction).toBe('unknown')
    expect(summary.action).toBe('upgrade')
  })
})

describe('comparisons', () => {
  it('lays the catalog specs side by side', () => {
    expect(summarize('max', LIVE_PRO).comparisons).toEqual([
      { label: 'Price', from: '$149/mo', to: '$499/mo' },
      { label: 'Included quota', from: '$250', to: '$900' },
      { label: 'Concurrency', from: '100 boxes', to: '1000 boxes' },
    ])
  })

  it('shows no subscription rather than $0 when there is no plan', () => {
    expect(summarize('pro', null).comparisons.map((row) => row.from)).toEqual([
      'No subscription',
      'No subscription',
      'No subscription',
    ])
  })

  it('shows a negotiated plan as Custom rather than inventing a price', () => {
    const managed: OrganizationPlan = { ...LIVE_PRO, planId: 'managed', planName: 'Managed' }

    expect(summarize('pro', managed).comparisons.map((row) => row.from)).toEqual(['Custom', 'Custom', 'Custom'])
  })
})

describe('effect', () => {
  it('warns a first subscribe that confirming leaves the dashboard', () => {
    const summary = summarize('pro', null)

    expect(summary.effect).toContain('Stripe')
    expect(summary.effect).toContain('leave the dashboard')
  })

  it('charges an upgrade on a live subscription immediately and prorated', () => {
    const summary = summarize('max', LIVE_PRO)

    expect(summary.effect).toContain('immediately')
    expect(summary.effect).toContain('prorated')
  })

  it('names the day a downgrade lands and says nothing is charged', () => {
    const summary = summarize('starter', LIVE_PRO)

    expect(summary.effect).toContain('Sep 5, 2026')
    expect(summary.effect).toContain('Nothing is charged today')
  })
})

describe('quota and wallet', () => {
  it('frames the unused quota a downgrade keeps, not loses', () => {
    const summary = summarize('starter', LIVE_PRO)

    expect(summary.quotaNote).toContain('$187.50')
    expect(summary.quotaNote).toContain('Sep 5, 2026')
  })

  it('says nothing about quota when upgrading', () => {
    expect(summarize('max', LIVE_PRO).quotaNote).toBeNull()
  })

  it('says nothing about quota on an unlimited plan', () => {
    expect(summarize('starter', { ...LIVE_PRO, quotaRemainingCents: null }).quotaNote).toBeNull()
  })

  it('names the wallet balance that funds overage', () => {
    const summary = summarize('starter', LIVE_PRO, {
      balanceCents: 1_000,
      ongoingBalanceCents: 1_000,
      name: 'Wallet',
      creditCardConnected: false,
    })

    expect(summary.walletNote).toContain('$10.00')
  })

  it('omits the wallet note before the wallet loads', () => {
    expect(summarize('starter', LIVE_PRO).walletNote).toBeNull()
  })
})

describe('caveats', () => {
  it('warns that a negotiated plan may refuse a self-serve switch', () => {
    const managed: OrganizationPlan = { ...LIVE_PRO, planId: 'managed', planName: 'Managed' }

    expect(summarize('pro', managed).caveats[0].text).toContain('negotiated plan')
  })

  // ThisCycleCard printed the raw id here; user-facing copy should not.
  it('names a queued change by its plan name, not its id', () => {
    const queued: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter' }
    const caveat = summarize('max', queued).caveats[0]

    expect(caveat.text).toContain('Starter')
    expect(caveat.text).not.toContain('starter')
  })

  it('lets a scheduled cancellation take precedence over a queued downgrade', () => {
    const canceling: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter', cancelAtPeriodEnd: true }

    expect(summarize('max', canceling).caveats[0].text).toContain('set to end')
  })

  it('stays quiet on an ordinary switch', () => {
    expect(summarize('max', LIVE_PRO).caveats).toEqual([])
  })
})

describe('blocked', () => {
  it('redirects a plan id the catalog does not carry', () => {
    expect(summarize('bogus', LIVE_PRO).blocked).toEqual({ kind: 'not-in-catalog', redirect: true })
  })

  it('redirects a plan that is not self-serve', () => {
    expect(summarize('enterprise', LIVE_PRO).blocked).toEqual({ kind: 'not-in-catalog', redirect: true })
  })

  // Back after a successful upgrade lands here; without this it is a dead page.
  it('redirects when the target is already the live plan', () => {
    expect(summarize('pro', LIVE_PRO).blocked).toEqual({ kind: 'same-plan', redirect: true })
  })

  it('lets a canceled subscription resubscribe to the same plan', () => {
    expect(summarize('pro', { ...LIVE_PRO, status: 'canceled' }).blocked).toBeNull()
  })

  it('explains rather than redirects when the target is already queued', () => {
    const queued: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter' }
    const blocked = summarize('starter', queued).blocked

    expect(blocked?.kind).toBe('already-queued')
    expect(blocked?.redirect).toBe(false)
  })

  it('does not block an ordinary switch', () => {
    expect(summarize('max', LIVE_PRO).blocked).toBeNull()
  })

  // A pending cancel supersedes a queued downgrade, so the queued plan is not
  // actually going to start. planCardCta already applies that rule and leaves
  // the card enabled; if blockFor disagrees, that card links to a page with no
  // action on it.
  it('does not call a queued plan scheduled when a cancellation supersedes it', () => {
    const canceling: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter', cancelAtPeriodEnd: true }
    const summary = summarize('starter', canceling)

    expect(summary.blocked).toBeNull()
    expect(cta('starter', canceling).disabled).toBe(false)
  })

  // `blocked` already says there is nothing to confirm; a caveat saying
  // "confirming replaces it" renders right beside it and contradicts it.
  it('drops the queued-change caveat when the queued plan is the one being viewed', () => {
    const queued: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter' }
    const summary = summarize('starter', queued)

    expect(summary.blocked?.kind).toBe('already-queued')
    expect(summary.caveats).toEqual([])
  })

  it('keeps the caveat when switching to a different plan than the queued one', () => {
    const queued: OrganizationPlan = { ...LIVE_PRO, pendingPlanId: 'starter' }

    expect(summarize('max', queued).caveats[0].text).toContain('already queued')
  })

  // A lapsed cycle can still carry the id it was going to roll into. Calling
  // that "already scheduled" contradicts the effect line, which says the
  // subscription has ended and this starts a new one — and leaves the page
  // with no Confirm button and no way to act.
  it('does not call a lapsed plan queued, so resubscribing to it stays possible', () => {
    const lapsed: OrganizationPlan = { ...LIVE_PRO, status: 'canceled', pendingPlanId: 'starter' }
    const summary = summarize('starter', lapsed)

    expect(summary.blocked).toBeNull()
    expect(summary.direction).toBe('subscribe')
  })
})

describe('caveats after the cycle lapsed', () => {
  it('does not claim a change is queued against a cycle that already ended', () => {
    const lapsed: OrganizationPlan = { ...LIVE_PRO, status: 'canceled', pendingPlanId: 'starter' }

    expect(summarize('max', lapsed).caveats).toEqual([])
  })

  it('does not claim a subscription is about to end once it already has', () => {
    const lapsed: OrganizationPlan = { ...LIVE_PRO, status: 'canceled', cancelAtPeriodEnd: true }

    expect(summarize('max', lapsed).caveats).toEqual([])
  })
})

describe('scheduledChange', () => {
  const queued = (extra: Partial<OrganizationPlan>) =>
    scheduledChange({ plan: { ...LIVE_PRO, ...extra }, catalog: CATALOG })

  it('says nothing when nothing is queued', () => {
    expect(scheduledChange({ plan: LIVE_PRO, catalog: CATALOG })).toBeNull()
    expect(scheduledChange({ plan: null, catalog: CATALOG })).toBeNull()
  })

  it('names the queued plan and the day it starts', () => {
    const change = queued({ pendingPlanId: 'starter' })

    expect(change?.kind).toBe('downgrade')
    expect(change?.text).toContain('Starter')
    expect(change?.text).toContain('Sep 5, 2026')
  })

  it('reassures that the current plan holds until then', () => {
    expect(queued({ pendingPlanId: 'starter' })?.text).toContain("Pro's quota and concurrency stay yours")
  })

  // ThisCycleCard printed the raw id here; user-facing copy should not.
  it('never prints a raw plan id', () => {
    expect(queued({ pendingPlanId: 'starter' })?.text).not.toContain('starter')
  })

  it('says what happens without inventing a name for an off-catalog queued plan', () => {
    const change = queued({ pendingPlanId: 'negotiated' })

    expect(change?.text).toContain('Sep 5, 2026')
    expect(change?.text).not.toContain('negotiated')
  })

  it('reads a scheduled cancellation as an ending, not a downgrade', () => {
    const change = queued({ cancelAtPeriodEnd: true })

    expect(change?.kind).toBe('cancel')
    expect(change?.text).toContain('subscription ends')
  })

  it('lets a cancellation outrank a queued downgrade', () => {
    expect(queued({ pendingPlanId: 'starter', cancelAtPeriodEnd: true })?.kind).toBe('cancel')
  })

  it('offers to keep the plan by name', () => {
    expect(queued({ pendingPlanId: 'starter' })?.keepLabel).toBe('Keep Pro')
    expect(queued({ cancelAtPeriodEnd: true })?.keepLabel).toBe('Keep Pro')
  })

  // The cycle already lapsed, so there is no roll left to schedule against.
  it('has nothing to keep once the subscription has ended', () => {
    expect(queued({ status: 'canceled', pendingPlanId: 'starter' })).toBeNull()
  })
})

describe('planCardCta', () => {
  it('marks the live plan as current and offers nothing to click', () => {
    expect(cta('pro', LIVE_PRO)).toEqual({ kind: 'current', label: 'Current plan', disabled: true })
  })

  it('offers an upgrade above the current price and a downgrade below it', () => {
    expect(cta('max', LIVE_PRO).kind).toBe('upgrade')
    expect(cta('starter', LIVE_PRO).kind).toBe('downgrade')
  })

  // Without this the card invites a click that dead-ends on the confirmation
  // page's already-queued notice.
  it('shows a queued plan as scheduled with its start date, not as a downgrade', () => {
    const scheduled = cta('starter', { ...LIVE_PRO, pendingPlanId: 'starter' })

    expect(scheduled).toEqual({ kind: 'scheduled', label: 'Starts Sep 5', disabled: true })
  })

  it('does not call a plan scheduled when a cancellation will replace it', () => {
    expect(cta('starter', { ...LIVE_PRO, pendingPlanId: 'starter', cancelAtPeriodEnd: true }).kind).toBe('downgrade')
  })

  // Otherwise the resubscribe path the confirmation page accepts is unreachable.
  it('lets a canceled subscription act on its own former plan', () => {
    expect(cta('pro', { ...LIVE_PRO, status: 'canceled' }).disabled).toBe(false)
  })

  it('reads every plan as an upgrade when there is no subscription', () => {
    expect(cta('starter', null).kind).toBe('upgrade')
  })
})

describe('queuedChange', () => {
  it('reports nothing queued against an untouched cycle', () => {
    expect(queuedChange(LIVE_PRO)).toBeNull()
    expect(queuedChange(null)).toBeNull()
  })

  it('names the plan a queued downgrade rolls into', () => {
    expect(queuedChange({ ...LIVE_PRO, pendingPlanId: 'starter' })).toEqual({
      kind: 'downgrade',
      planId: 'starter',
    })
  })

  // The plan id stays set behind a cancellation, but that downgrade never runs.
  // Every surface reads this one predicate so none of them can disagree.
  it('lets a cancellation outrank the downgrade queued behind it', () => {
    expect(queuedChange({ ...LIVE_PRO, pendingPlanId: 'starter', cancelAtPeriodEnd: true })).toEqual({ kind: 'cancel' })
  })

  it('reports nothing queued once the cycle has already lapsed', () => {
    expect(queuedChange({ ...LIVE_PRO, pendingPlanId: 'starter', status: 'canceled' })).toBeNull()
  })
})
