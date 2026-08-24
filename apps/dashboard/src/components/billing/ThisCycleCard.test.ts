import { describe, expect, it } from 'vitest'
import { OrganizationPlan } from '@/billing-api'
import { cycleFacts } from './ThisCycleCard'

// Noon-UTC instants so the local calendar day matches UTC in any test zone.
const plan: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date('2026-08-05T12:00:00.000Z'),
  cycleTo: new Date('2026-09-05T12:00:00.000Z'),
  includedQuotaCents: 25000,
  quotaConsumedCents: 6250,
  quotaRemainingCents: 18750,
}
const now = new Date('2026-08-14T12:00:00.000Z')
const catalog = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthlyCents: 1_900,
    includedQuotaCents: 3_000,
    concurrencyLimit: 20,
    selfServe: true,
  },
]

describe('cycleFacts', () => {
  it('counts the days to the roll and states the window', () => {
    const facts = cycleFacts(plan, now)
    expect(facts).toMatchObject({ unlimited: false, daysLeft: 22, note: null })
    expect(facts.window).toBe('Aug 5 – Sep 5')
  })

  it('never counts below zero after the cycle lapsed', () => {
    expect(cycleFacts(plan, new Date('2026-09-20T12:00:00.000Z')).daysLeft).toBe(0)
  })

  it('reads a null grant as unlimited — a negotiated deal, not zero quota', () => {
    const custom = { ...plan, includedQuotaCents: null, quotaRemainingCents: null }
    expect(cycleFacts(custom, now).unlimited).toBe(true)
  })

  it('notes a cancellation with the date the quota survives to', () => {
    const facts = cycleFacts({ ...plan, status: 'canceled' }, now)
    expect(facts.note).toBe('Canceled — quota stays usable until Sep 5, then pay-as-you-go from the wallet')
  })

  it('notes a queued downgrade with the roll date, cancellation taking precedence', () => {
    expect(cycleFacts({ ...plan, pendingPlanId: 'starter' }, now, catalog).note).toBe(
      'Downgrades to Starter when the cycle rolls on Sep 5',
    )
    expect(cycleFacts({ ...plan, status: 'canceled', pendingPlanId: 'starter' }, now, catalog).note).toMatch(
      /^Canceled/,
    )
  })

  // A negotiated plan never appears in the public catalog, so there is no name
  // to resolve — but the note still has to say something.
  it('falls back to the id only when the catalog cannot name the queued plan', () => {
    expect(cycleFacts({ ...plan, pendingPlanId: 'negotiated' }, now, catalog).note).toBe(
      'Downgrades to negotiated when the cycle rolls on Sep 5',
    )
  })
})
