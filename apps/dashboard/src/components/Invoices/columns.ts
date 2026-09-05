/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Invoice } from '@/billing-api'

/**
 * What each document kind is called on the billing page. Keyed loosely on
 * purpose: the listing asks Commerce for every kind, so a kind added there
 * arrives here before this map knows about it, and an unlabelled row is far
 * better than a missing one.
 */
const INVOICE_LABEL: Record<string, string> = {
  advance_charges: 'Usage',
  subscription: 'Renewal',
  one_off: 'Upgrade',
  // Not "Top-up": a standing auto-reload rule issues the same document without
  // anyone clicking, and the invoice carries no `source` to tell the two apart.
  // Which rule fired is ledger provenance, and Credit activity already says it.
  credit: 'Credits',
}

/** Falls back to the raw wire name so an unmapped kind still reads as something. */
export function invoiceLabel(invoice: Invoice): string {
  return INVOICE_LABEL[invoice.type] ?? invoice.type
}

export type InvoiceStatus = 'voided' | 'succeeded' | 'pending' | 'failed'

/**
 * A voided document was cancelled after issue, which outranks however its
 * payment ended — a voided-but-succeeded row must not read as money kept.
 */
export function invoiceStatus(invoice: Invoice): InvoiceStatus {
  return invoice.voided ? 'voided' : invoice.paymentStatus
}
