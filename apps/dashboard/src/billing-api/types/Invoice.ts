/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/** A usage settlement that was funded when Commerce recorded it. */
export interface Invoice {
  id: string
  number: string
  sequentialId: number
  chargedAt: string
  totalAmountCents: number
  quotaCoveredCents: number
  voided: boolean
}

export interface PaginatedInvoices {
  items: Invoice[]
  totalItems: number
  totalPages: number
}
