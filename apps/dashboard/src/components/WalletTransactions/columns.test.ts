/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { WalletTransaction } from '@/billing-api'
import { describe, expect, it } from 'vitest'
import { walletTransactionLabel } from './columns'

const transaction: WalletTransaction = {
  id: 'transaction-1',
  direction: 'inbound',
  kind: 'granted',
  status: 'settled',
  source: 'manual',
  amountCents: 1_000,
  name: null,
  subscriptionCreditKind: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  settledAt: '2026-08-30T00:00:00.000Z',
}

describe('walletTransactionLabel', () => {
  it.each([
    [{ ...transaction, kind: 'purchased', source: 'manual' }, 'Top-up'],
    [{ ...transaction, kind: 'purchased', source: 'threshold' }, 'Auto top-up'],
    [{ ...transaction, direction: 'outbound', kind: 'invoiced' }, 'Usage'],
    [{ ...transaction, kind: 'expired' }, 'Expiry'],
    [{ ...transaction, subscriptionCreditKind: 'cycle' }, 'Subscription'],
    [{ ...transaction, subscriptionCreditKind: 'upgrade' }, 'Upgrade'],
    [{ ...transaction, name: 'Coupon SAVE10' }, 'Coupon'],
    [{ ...transaction, name: 'Signup credit' }, 'Signup'],
    [{ ...transaction, name: 'Goodwill adjustment' }, 'Goodwill'],
    [{ ...transaction, name: 'Launch promotion' }, 'Promotion'],
    [
      {
        ...transaction,
        kind: 'granted',
        name: 'Restored subscription credit for BOX-2026-0002',
        subscriptionCreditKind: 'void_restore',
      },
      'Restore',
    ],
    [{ ...transaction, kind: 'granted', name: 'Voided BOX-2026-0002' }, 'Refund'],
  ] satisfies Array<[WalletTransaction, string]>)('maps ledger axes to %s', (input, expected) => {
    expect(walletTransactionLabel(input)).toBe(expected)
  })
})
