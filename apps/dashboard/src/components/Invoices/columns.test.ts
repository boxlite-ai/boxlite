/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Invoice } from '@/billing-api'
import { describe, expect, it } from 'vitest'
import { invoiceLabel, invoiceStatus } from './columns'

const invoice: Invoice = {
  id: 'invoice-1',
  number: 'BOX-2026-0001',
  sequentialId: 1,
  type: 'advance_charges',
  chargedAt: '2026-09-04T00:00:00.000Z',
  totalAmountCents: 1_212,
  totalPaidCents: 1_212,
  quotaCoveredCents: 0,
  paymentStatus: 'succeeded',
  voided: false,
}

describe('invoiceLabel', () => {
  it.each([
    ['advance_charges', 'Usage'],
    ['subscription', 'Renewal'],
    ['one_off', 'Upgrade'],
    ['credit', 'Credits'],
  ] as const)('names %s on the billing page', (type, expected) => {
    expect(invoiceLabel({ ...invoice, type })).toBe(expected)
  })

  it('never calls a credit document a top-up, which only the manual rail is', () => {
    // An auto-reload rule issues this same document off-session. The wire has
    // no `source`, so borrowing the credit ledger's word for the manual rail
    // would put "top-up" on a charge nobody clicked.
    expect(invoiceLabel({ ...invoice, type: 'credit' }).toLowerCase()).not.toContain('top-up')
  })

  it('falls back to the wire name for a kind Commerce added later', () => {
    // The listing asks for every kind, so an unmapped one arrives before this
    // map knows it. A raw name is visible enough to get fixed; `undefined` is not.
    expect(invoiceLabel({ ...invoice, type: 'progressive_billing' as Invoice['type'] })).toBe('progressive_billing')
  })
})

describe('invoiceStatus', () => {
  it.each([
    ['succeeded', 'succeeded'],
    ['pending', 'pending'],
    ['failed', 'failed'],
  ] as const)('reports %s payment as-is', (paymentStatus, expected) => {
    expect(invoiceStatus({ ...invoice, paymentStatus })).toBe(expected)
  })

  it('reports a voided document as voided even when its payment succeeded', () => {
    expect(invoiceStatus({ ...invoice, paymentStatus: 'succeeded', voided: true })).toBe('voided')
  })
})
