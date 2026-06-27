/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InboundLot } from './wallet-math'
import { planCredit, planDebit } from './wallet-plan'

const T0 = new Date('2026-06-27T12:00:00Z')
const lot = (id: string, pool: 'free' | 'paid', remainingCents: number): InboundLot => ({
  id,
  pool,
  priority: pool === 'free' ? 1 : 2,
  remainingCents,
  expiresAt: null,
  createdAt: T0,
})

const sumLedger = (rows: { direction: string; amountCents: number }[]) =>
  rows.reduce((s, r) => s + (r.direction === 'inbound' ? r.amountCents : -r.amountCents), 0)

describe('planDebit', () => {
  it('burns free then paid, balance stays = free + paid when non-negative', () => {
    const plan = planDebit(
      { balanceCents: 800, freeBalanceCents: 300, paidBalanceCents: 500 },
      [lot('f', 'free', 300), lot('p', 'paid', 500)],
      400,
      T0,
      { source: 'usage', ratedPeriodId: 'r1' },
    )

    expect(plan.balances).toEqual({ balanceCents: 400, freeBalanceCents: 0, paidBalanceCents: 400 })
    expect(plan.overageCents).toBe(0)
    expect(plan.balances.balanceCents).toBe(plan.balances.freeBalanceCents + plan.balances.paidBalanceCents)
    // two outbound rows summing to the debit; balance change = SUM(ledger)
    expect(sumLedger(plan.ledgerRows)).toBe(-400)
    expect(plan.lotBurns).toEqual([
      { lotId: 'f', newRemainingCents: 0 },
      { lotId: 'p', newRemainingCents: 400 },
    ])
  })

  it('goes bounded-negative on overage, with a debt row keeping SUM(ledger) exact', () => {
    const plan = planDebit(
      { balanceCents: 300, freeBalanceCents: 300, paidBalanceCents: 0 },
      [lot('f', 'free', 300)],
      500,
      T0,
      { source: 'usage', ratedPeriodId: 'r2' },
    )

    expect(plan.balances).toEqual({ balanceCents: -200, freeBalanceCents: 0, paidBalanceCents: 0 })
    expect(plan.overageCents).toBe(200)
    expect(sumLedger(plan.ledgerRows)).toBe(-500) // 300 covered + 200 debt
    expect(plan.ledgerRows).toHaveLength(2)
  })

  it('the rated period id rides onto every outbound row (audit trail)', () => {
    const plan = planDebit(
      { balanceCents: 100, freeBalanceCents: 100, paidBalanceCents: 0 },
      [lot('f', 'free', 100)],
      50,
      T0,
      { source: 'usage', ratedPeriodId: 'rp-9' },
    )
    expect(plan.ledgerRows.every((r) => r.ratedPeriodId === 'rp-9')).toBe(true)
  })
})

describe('planCredit', () => {
  it('top-up funds the paid pool when the balance is non-negative', () => {
    const plan = planCredit({ balanceCents: 0, freeBalanceCents: 0, paidBalanceCents: 0 }, 1000, 'paid', {
      source: 'manual',
      expiresAt: null,
    })
    expect(plan.balances).toEqual({ balanceCents: 1000, freeBalanceCents: 0, paidBalanceCents: 1000 })
    expect(plan.settledNegativeCents).toBe(0)
    expect(plan.ledgerRow).toMatchObject({
      pool: 'paid',
      direction: 'inbound',
      amountCents: 1000,
      remainingCents: 1000,
    })
  })

  it('top-up settles a carried negative balance first, surplus is spendable', () => {
    const plan = planCredit({ balanceCents: -50, freeBalanceCents: 0, paidBalanceCents: 0 }, 1000, 'paid', {
      source: 'manual',
      expiresAt: null,
    })
    expect(plan.balances).toEqual({ balanceCents: 950, freeBalanceCents: 0, paidBalanceCents: 950 })
    expect(plan.settledNegativeCents).toBe(50)
    expect(plan.ledgerRow.remainingCents).toBe(950) // only the surplus can be burned later
    // invariant restored: balance == free + paid once non-negative
    expect(plan.balances.balanceCents).toBe(plan.balances.freeBalanceCents + plan.balances.paidBalanceCents)
  })

  it('grant funds the free pool and carries an expiry', () => {
    const expiry = new Date('2026-07-27T00:00:00Z')
    const plan = planCredit({ balanceCents: 0, freeBalanceCents: 0, paidBalanceCents: 0 }, 500, 'free', {
      source: 'grant',
      expiresAt: expiry,
    })
    expect(plan.balances).toEqual({ balanceCents: 500, freeBalanceCents: 500, paidBalanceCents: 0 })
    expect(plan.ledgerRow).toMatchObject({ pool: 'free', amountCents: 500, remainingCents: 500, expiresAt: expiry })
  })

  it('grant settles debt first too (keeps balance == free + paid)', () => {
    const plan = planCredit({ balanceCents: -100, freeBalanceCents: 0, paidBalanceCents: 0 }, 300, 'free', {
      source: 'grant',
      expiresAt: null,
    })
    expect(plan.balances).toEqual({ balanceCents: 200, freeBalanceCents: 200, paidBalanceCents: 0 })
    expect(plan.settledNegativeCents).toBe(100)
    expect(plan.balances.balanceCents).toBe(plan.balances.freeBalanceCents + plan.balances.paidBalanceCents)
  })
})
