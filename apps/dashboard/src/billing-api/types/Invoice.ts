/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The billing document kinds Commerce mints. Hand-copied from the service:
 * the billing client is written by hand rather than generated, so this union
 * has to be kept in step with Commerce's INVOICE_TYPES by eye.
 */
export type InvoiceType = 'advance_charges' | 'subscription' | 'one_off' | 'credit'

/**
 * Which documents a listing should return.
 *
 * `'all'` asks Commerce for every kind it currently mints, so a type added
 * later shows up without a dashboard deploy — money is never silently missing
 * from a billing history. Pass an explicit list only where excluding an
 * unknown future kind is the point, such as a per-type filter.
 */
export type InvoiceTypeFilter = 'all' | InvoiceType[]

/** A billing document: a usage settlement, a plan charge, or a credit purchase. */
export interface Invoice {
  id: string
  number: string
  sequentialId: number
  type: InvoiceType
  chargedAt: string
  totalAmountCents: number
  totalPaidCents: number
  quotaCoveredCents: number
  paymentStatus: 'pending' | 'succeeded' | 'failed'
  voided: boolean
}

/**
 * What a Commerce that predates the billing-history change still serves: the
 * three fields below arrived with the `type` filter, and either side may deploy
 * first. The client fills them in so a settlement renders rather than throwing.
 */
export type LegacyInvoice = Omit<Invoice, 'type' | 'totalPaidCents' | 'paymentStatus'> &
  Partial<Pick<Invoice, 'type' | 'totalPaidCents' | 'paymentStatus'>>

export interface PaginatedInvoices {
  items: Invoice[]
  totalItems: number
  totalPages: number
}
