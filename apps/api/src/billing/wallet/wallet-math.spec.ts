/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { applyTopUp, burnDown, deriveBillingStatus, InboundLot } from './wallet-math'

const T0 = new Date('2026-06-27T12:00:00Z')
const lot = (
  over: Partial<InboundLot> & { id: string; pool: 'free' | 'paid'; remainingCents: number },
): InboundLot => ({
  priority: over.pool === 'free' ? 1 : 2,
  expiresAt: null,
  createdAt: T0,
  ...over,
})

describe('burnDown', () => {
  it('drains the free pool before the paid pool', () => {
    const lots = [
      lot({ id: 'paid1', pool: 'paid', remainingCents: 500 }),
      lot({ id: 'free1', pool: 'free', remainingCents: 300 }),
    ]
    // burn 400 → free 300 fully, then paid 100
    expect(burnDown(lots, 400, T0)).toEqual({
      debits: [
        { lotId: 'free1', pool: 'free', cents: 300 },
        { lotId: 'paid1', pool: 'paid', cents: 100 },
      ],
      overageCents: 0,
    })
  })

  it('reports overage when both pools are exhausted', () => {
    const lots = [
      lot({ id: 'free1', pool: 'free', remainingCents: 300 }),
      lot({ id: 'paid1', pool: 'paid', remainingCents: 500 }),
    ]
    const r = burnDown(lots, 1000, T0)
    expect(r.debits.reduce((s, d) => s + d.cents, 0)).toBe(800)
    expect(r.overageCents).toBe(200)
  })

  it('excludes lots that are already expired at `now`', () => {
    const lots = [
      lot({ id: 'freeExpired', pool: 'free', remainingCents: 300, expiresAt: new Date('2026-06-26T12:00:00Z') }),
      lot({ id: 'paid1', pool: 'paid', remainingCents: 500 }),
    ]
    // free is expired → 400 comes entirely from paid
    expect(burnDown(lots, 400, T0)).toEqual({
      debits: [{ lotId: 'paid1', pool: 'paid', cents: 400 }],
      overageCents: 0,
    })
  })

  it('within a pool, burns the soonest-expiring lot first', () => {
    const lots = [
      lot({ id: 'late', pool: 'free', remainingCents: 200, expiresAt: new Date('2026-07-10T00:00:00Z') }),
      lot({ id: 'soon', pool: 'free', remainingCents: 200, expiresAt: new Date('2026-06-30T00:00:00Z') }),
    ]
    const r = burnDown(lots, 200, T0)
    expect(r.debits).toEqual([{ lotId: 'soon', pool: 'free', cents: 200 }])
  })

  it('is a no-op for non-positive amounts', () => {
    expect(burnDown([lot({ id: 'f', pool: 'free', remainingCents: 300 })], 0, T0)).toEqual({
      debits: [],
      overageCents: 0,
    })
  })
})

describe('applyTopUp', () => {
  it('funds the paid pool entirely when the balance is non-negative', () => {
    expect(applyTopUp(0, 1000)).toEqual({ settleNegativeCents: 0, toPaidPoolCents: 1000 })
  })

  it('settles a carried negative balance first, surplus to the paid pool', () => {
    expect(applyTopUp(-50, 1000)).toEqual({ settleNegativeCents: 50, toPaidPoolCents: 950 })
  })

  it('uses the whole top-up to settle when it does not cover the deficit', () => {
    expect(applyTopUp(-1500, 1000)).toEqual({ settleNegativeCents: 1000, toPaidPoolCents: 0 })
  })
})

describe('deriveBillingStatus', () => {
  it('refines active into low_balance / zero_balance from the live balance', () => {
    expect(deriveBillingStatus('active', 5000, 1000)).toBe('active')
    expect(deriveBillingStatus('active', 800, 1000)).toBe('low_balance')
    expect(deriveBillingStatus('active', 0, 1000)).toBe('zero_balance')
    expect(deriveBillingStatus('active', -20, 1000)).toBe('zero_balance')
  })

  it('passes through authoritative stored states unchanged', () => {
    expect(deriveBillingStatus('trial', 5000, 1000)).toBe('trial')
    expect(deriveBillingStatus('suspended', 5000, 1000)).toBe('suspended')
    expect(deriveBillingStatus('closed', 5000, 1000)).toBe('closed')
  })
})
