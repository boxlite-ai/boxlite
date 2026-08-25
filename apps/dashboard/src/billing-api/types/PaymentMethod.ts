/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface PaymentMethod {
  id: string
  isDefault: boolean
  paymentProviderType: 'stripe'
  providerMethodId: string
  details: Record<string, unknown>
}

export interface PaginatedPaymentMethods {
  paymentMethods: PaymentMethod[]
  meta: {
    currentPage: number
    totalPages: number
    totalCount: number
    nextPage: number | null
    prevPage: number | null
  }
}
