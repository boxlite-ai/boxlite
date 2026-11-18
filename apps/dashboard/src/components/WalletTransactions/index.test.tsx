// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { WalletTransaction } from '@/billing-api'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WalletTransactionsTable } from '.'

const transaction: WalletTransaction = {
  id: 'transaction-1',
  direction: 'inbound',
  kind: 'purchased',
  status: 'settled',
  source: 'manual',
  amountCents: 10_000,
  name: null,
  subscriptionCreditKind: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  settledAt: '2026-07-01T00:00:00.000Z',
}

describe('WalletTransactionsTable PR #829 surface', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  it('shows an empty credit history only after loading finishes', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<WalletTransactionsTable data={[]} loading />))
    expect(host.querySelector('[role="status"] h2')?.textContent).toBe('Loading credit activity…')
    expect(host.textContent).not.toContain('No credit activity yet')
    act(() => root?.render(<WalletTransactionsTable data={[]} loading={false} />))
    expect(host.querySelector('h2')?.textContent).toBe('No credit activity yet')
    expect(host.textContent).toContain('Credit purchases, grants and usage')
    expect(host.querySelector('[data-transaction-header]')).toBeNull()
  })

  it('keeps the exact transaction grid, date, amount, and status vocabulary', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(<WalletTransactionsTable data={[transaction]} loading={false} />)
    })

    expect(Array.from(host.querySelectorAll('[data-transaction-header]')).map((header) => header.textContent)).toEqual([
      'Date',
      'Type',
      '',
      'Amount',
      'Status',
    ])
    expect(host.querySelector('[data-transaction-date]')?.textContent).toBe('2026-07-01')
    expect(host.querySelector('[data-transaction-type]')?.textContent).toBe('Top-up')
    expect(host.querySelector('[data-transaction-amount]')?.textContent).toBe('+100.00')
    expect(host.querySelector('[data-transaction-status]')?.textContent).toBe('ok')
    expect(host.textContent).not.toContain('Details')
    expect(host.textContent).not.toContain('Page 1 of 1')
  })

  it('renders a status Commerce added later instead of throwing', () => {
    // `status` is hand-copied from the service, so an unmapped value reaches
    // this table before the map knows it and used to hit `undefined.color`.
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        <WalletTransactionsTable
          data={[{ ...transaction, status: 'reversed' as WalletTransaction['status'] }]}
          loading={false}
        />,
      )
    })

    expect(host.querySelector('[data-transaction-status]')?.textContent).toBe('reversed')
    expect(host.querySelectorAll('[data-transaction-date]')).toHaveLength(1)
  })
})
