import { describe, expect, it } from 'vitest'
import { OrganizationPlan } from '@/billing-api'
import { billingMode } from './CycleOverview'

const plan: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date('2026-08-05T12:00:00.000Z'),
  cycleTo: new Date('2026-09-05T12:00:00.000Z'),
  includedQuotaCents: 25_000,
  quotaConsumedCents: 6_250,
  quotaRemainingCents: 18_750,
}

describe('billingMode', () => {
  it('reads a live plan as the plan mode, whatever credit sits behind it', () => {
    expect(billingMode({ creditGrantedCents: 10_000, creditRemainingCents: 10_000 }, plan)).toEqual({
      kind: 'plan',
      plan,
    })
  })

  it('reads an unsubscribed account with a grant as a free trial', () => {
    expect(billingMode({ creditGrantedCents: 10_000, creditRemainingCents: 6_230 })).toEqual({
      kind: 'free-trial',
      grantedCents: 10_000,
      remainingCents: 6_230,
    })
  })

  it('stays a free trial once the grant is spent — the account is still on one', () => {
    expect(billingMode({ creditGrantedCents: 10_000, creditRemainingCents: 0 })).toEqual({
      kind: 'free-trial',
      grantedCents: 10_000,
      remainingCents: 0,
    })
  })

  it('is pay-as-you-go when Commerce has granted nothing', () => {
    // The state a fresh account is in today: the grant is not implemented, so
    // claiming a free trial would promise credit the wallet does not hold.
    expect(billingMode({ creditGrantedCents: 0, creditRemainingCents: 0 })).toEqual({ kind: 'payg' })
  })

  it('is pay-as-you-go when Commerce reports no credit fields at all', () => {
    expect(billingMode({})).toEqual({ kind: 'payg' })
  })

  it('treats a granted-but-unreported remainder as fully spent rather than inventing one', () => {
    expect(billingMode({ creditGrantedCents: 10_000 })).toEqual({
      kind: 'free-trial',
      grantedCents: 10_000,
      remainingCents: 0,
    })
  })
})
