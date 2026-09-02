/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { WalletTransaction } from '@/billing-api'

/** Translate durable ledger axes into the compact type label used by PR #829. */
export function walletTransactionLabel(transaction: WalletTransaction): string {
  if (transaction.kind === 'purchased') {
    return transaction.source === 'manual' ? 'Top-up' : 'Auto top-up'
  }
  if (transaction.kind === 'invoiced') return 'Usage'
  if (transaction.kind === 'expired') return 'Expiry'
  if (transaction.kind === 'voided') return 'Refund'
  if (transaction.subscriptionCreditKind === 'cycle') return 'Subscription'
  if (transaction.subscriptionCreditKind === 'upgrade') return 'Upgrade'
  if (transaction.subscriptionCreditKind === 'void_restore') return 'Restore'

  const normalizedName = transaction.name?.toLowerCase() ?? ''
  if (normalizedName.startsWith('voided ')) return 'Refund'
  if (normalizedName.startsWith('coupon')) return 'Coupon'
  if (normalizedName.includes('signup')) return 'Signup'
  if (normalizedName.includes('goodwill')) return 'Goodwill'
  return 'Promotion'
}
