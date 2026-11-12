/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceEmptyState, StatusIndicator } from '@/components/ResourceLayout'
import { FileText } from '@/components/ui/icon'
import type { Invoice } from '@/billing-api'
import type { InvoicesTableProps } from './types'
import { invoiceLabel, invoiceStatus, type InvoiceStatus } from './columns'

// The credit ledger's grid, so the two lists line up column for column when
// they sit on the same page.
const ROW = 'grid grid-cols-[100px_110px_1fr_90px_80px] items-center gap-x-4'

const MUTED = 'hsl(var(--muted-foreground))'

// Keyed loosely for the same reason INVOICE_LABEL is: `paymentStatus` is a
// hand-copied union, so a value Commerce adds later arrives here before this
// map knows it. A row that reads oddly beats a billing page that throws.
const STATUS: Record<string, { label: string; color: string } | undefined> = {
  succeeded: { label: 'paid', color: 'hsl(var(--success))' },
  pending: { label: 'pending', color: 'hsl(var(--warning))' },
  failed: { label: 'failed', color: 'hsl(var(--destructive))' },
  voided: { label: 'voided', color: MUTED },
}

/**
 * Returns the display label and color for an invoice status.
 * Falls back to a muted color and the raw status name for unmapped values.
 *
 * @param status - The invoice status
 * @returns Label, HSL color, and whether display normalization is safe
 */
function statusMark(status: InvoiceStatus): { label: string; color: string; normalizeLabel: boolean } {
  const mapped = STATUS[status]
  return mapped ? { ...mapped, normalizeLabel: true } : { label: status, color: MUTED, normalizeLabel: false }
}

/**
 * Extracts the date portion from an invoice's charged timestamp.
 *
 * @param invoice - The invoice
 * @returns Date string in YYYY-MM-DD format
 */
function invoiceDate(invoice: Invoice): string {
  return invoice.chargedAt.slice(0, 10)
}

/**
 * Formats the amount actually charged to the payment method.
 * What reached the payment method, not what the document totalled. A usage
 * settlement covered by included quota is charged nothing, and showing its
 * gross total here would contradict the section's own note.
 *
 * @param invoice - The invoice
 * @returns Formatted dollar amount with two decimal places
 */
function invoiceAmount(invoice: Invoice): string {
  return (invoice.totalPaidCents / 100).toFixed(2)
}

/**
 * Renders a table of billing invoices with columns for date, type, number, amount, and status.
 * Shows a loading state or empty state when appropriate.
 *
 * @param props - Component props
 * @param props.data - Array of invoices to display
 * @param props.loading - Whether the data is currently loading
 * @returns The invoices table component
 */
export function InvoicesTable({ data, loading }: InvoicesTableProps) {
  if (loading) {
    return <div className="border-b border-border/40 py-[13px] font-mono text-body">Loading...</div>
  }

  if (data.length === 0) {
    return (
      <ResourceEmptyState
        title="No billing documents yet."
        icon={<FileText className="size-6" />}
        description="Billing documents appear here after charges are processed."
      />
    )
  }

  return (
    // A page holds 25 documents, which ran to roughly 1100px — the section
    // pushed everything under it off the screen and the pager with it. Bounded
    // here instead, with the header kept inside the scroller and stuck to its
    // top: a header outside would drift out of alignment by the scrollbar's
    // width the moment one appeared. `max-h` rather than a fixed height so an
    // account with three invoices does not get a box of empty rows.
    <div className="scrollbar-elevated max-h-[420px] overflow-y-auto">
      <div className={`${ROW} sticky top-0 z-10 resource-list-head bg-background`}>
        <span data-invoice-header>Date</span>
        <span data-invoice-header>Type</span>
        <span data-invoice-header>Number</span>
        <span data-invoice-header className="text-right">
          Amount
        </span>
        <span data-invoice-header className="text-right">
          Status
        </span>
      </div>
      {data.map((invoice) => {
        const status = statusMark(invoiceStatus(invoice))
        return (
          <div key={invoice.id} className={`${ROW} resource-list-row font-sans`}>
            <span data-invoice-date className="font-mono text-foreground">
              {invoiceDate(invoice)}
            </span>
            <span data-invoice-type className="text-muted-foreground">
              {invoiceLabel(invoice)}
            </span>
            <span data-invoice-number className="truncate font-mono text-muted-foreground">
              {invoice.number}
            </span>
            <span
              data-invoice-amount
              className={`text-right font-mono tabular-nums ${invoice.voided ? 'text-muted-foreground line-through' : 'text-foreground'}`}
            >
              {invoiceAmount(invoice)}
            </span>
            <span className="text-right">
              <StatusIndicator data-invoice-status {...status} />
            </span>
          </div>
        )
      })}
    </div>
  )
}
