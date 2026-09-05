// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Invoice } from '@/billing-api'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { InvoicesTable } from '.'

const invoice: Invoice = {
  id: 'invoice-1',
  number: 'BOX-2026-0001',
  sequentialId: 1,
  type: 'one_off',
  chargedAt: '2026-09-04T00:00:00.000Z',
  totalAmountCents: 54_837,
  totalPaidCents: 54_837,
  quotaCoveredCents: 0,
  paymentStatus: 'succeeded',
  voided: false,
}

describe('InvoicesTable', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  /** Mount the table on a fresh host and hand back that host to assert against. */
  function render(data: Invoice[]): HTMLDivElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = createRoot(host)
    root = mounted
    act(() => {
      mounted.render(<InvoicesTable data={data} loading={false} />)
    })
    return host
  }

  it('lays the money history out on the credit ledger grid', () => {
    const target = render([invoice])

    expect(Array.from(target.querySelectorAll('[data-invoice-header]')).map((header) => header.textContent)).toEqual([
      'Date',
      'Type',
      'Number',
      'Amount',
      'Status',
    ])
    expect(target.querySelector('[data-invoice-date]')?.textContent).toBe('2026-09-04')
    expect(target.querySelector('[data-invoice-type]')?.textContent).toBe('upgrade')
    expect(target.querySelector('[data-invoice-number]')?.textContent).toBe('BOX-2026-0001')
    expect(target.querySelector('[data-invoice-status]')?.textContent).toBe('paid')
  })

  it('shows the price charged for an upgrade, not the quota it granted', () => {
    const target = render([invoice])

    // The wallet ledger's row for this same upgrade reads +548.37 of granted
    // quota; the amount actually billed is a different number and belongs here.
    expect(target.querySelector('[data-invoice-amount]')?.textContent).toBe('548.37')
  })

  it('shows what reached the card, not the gross total, when quota covered the usage', () => {
    // The section promises "amounts charged to your payment method". A usage
    // settlement fully absorbed by included quota charged nothing, so printing
    // its 121.50 gross would be the same class of lie this page exists to end.
    const target = render([
      { ...invoice, type: 'advance_charges', totalAmountCents: 12_150, totalPaidCents: 0, quotaCoveredCents: 12_150 },
    ])

    expect(target.querySelector('[data-invoice-amount]')?.textContent).toBe('0.00')
  })

  it('shows a partly quota-covered settlement at the amount actually charged', () => {
    const target = render([
      { ...invoice, type: 'advance_charges', totalAmountCents: 9_847, totalPaidCents: 1_847, quotaCoveredCents: 8_000 },
    ])

    expect(target.querySelector('[data-invoice-amount]')?.textContent).toBe('18.47')
  })

  it('shows nothing charged for a failed payment, whatever the document totalled', () => {
    // The column reports what reached the card. A failed charge moved no money,
    // so echoing the document total here would read as a payment that happened.
    const target = render([{ ...invoice, totalAmountCents: 8_900, totalPaidCents: 0, paymentStatus: 'failed' }])

    expect(target.querySelector('[data-invoice-amount]')?.textContent).toBe('0.00')
    expect(target.querySelector('[data-invoice-status]')?.textContent).toBe('failed')
  })

  it('renders a payment status Commerce added later instead of throwing', () => {
    // Same hand-copied-union hazard as the type map: `STATUS` has four keys and
    // an unmapped one used to reach `undefined.color` and take the page down.
    const target = render([{ ...invoice, paymentStatus: 'disputed' as Invoice['paymentStatus'] }])

    expect(target.querySelector('[data-invoice-status]')?.textContent).toBe('disputed')
    expect(target.querySelectorAll('[data-invoice-date]')).toHaveLength(1)
  })

  it('strikes a voided document through and stops calling it paid', () => {
    const target = render([{ ...invoice, voided: true }])

    const amount = target.querySelector('[data-invoice-amount]')
    expect(amount?.textContent).toBe('548.37')
    expect(amount?.className).toContain('line-through')
    expect(target.querySelector('[data-invoice-status]')?.textContent).toBe('voided')
  })

  it('says the history is empty rather than rendering a bare header', () => {
    const target = render([])

    expect(target.textContent).toContain('No billing documents yet.')
    expect(target.querySelectorAll('[data-invoice-header]')).toHaveLength(0)
  })
})
