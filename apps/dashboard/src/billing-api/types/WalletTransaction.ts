/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface WalletTransaction {
  id: string
  direction: 'inbound' | 'outbound'
  kind: 'purchased' | 'granted' | 'voided' | 'invoiced' | 'expired'
  status: 'pending' | 'settled' | 'failed'
  source: 'manual' | 'interval' | 'threshold'
  amountCents: number
  name: string | null
  subscriptionCreditKind: 'cycle' | 'upgrade' | 'void_restore' | null
  createdAt: string
  settledAt: string | null
}

export interface PaginatedWalletTransactions {
  items: WalletTransaction[]
  totalItems: number
  totalPages: number
}
