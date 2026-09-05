/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

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

function statusMark(status: InvoiceStatus): { label: string; color: string } {
  return STATUS[status] ?? { label: status, color: MUTED }
}

function invoiceDate(invoice: Invoice): string {
  return invoice.chargedAt.slice(0, 10)
}

/**
 * What reached the payment method, not what the document totalled. A usage
 * settlement covered by included quota is charged nothing, and showing its
 * gross total here would contradict the section's own note.
 */
function invoiceAmount(invoice: Invoice): string {
  return (invoice.totalPaidCents / 100).toFixed(2)
}

export function InvoicesTable({ data, loading }: InvoicesTableProps) {
  if (loading) {
    return <div className="border-b border-border/40 py-[13px] font-mono text-[13px]">Loading...</div>
  }

  if (data.length === 0) {
    return (
      <div className="border-b border-border/40 py-[13px] font-mono text-[13px] text-muted-foreground">
        No billing documents yet.
      </div>
    )
  }

  return (
    <div>
      <div
        className={`${ROW} border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`}
      >
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
          <div
            key={invoice.id}
            className={`${ROW} border-b border-border/40 py-[13px] font-mono text-[13px] transition-colors hover:bg-muted/30`}
          >
            <span data-invoice-date className="text-foreground">
              {invoiceDate(invoice)}
            </span>
            <span data-invoice-type className="uppercase tracking-[0.5px] text-muted-foreground">
              {invoiceLabel(invoice).toLowerCase()}
            </span>
            <span data-invoice-number className="truncate text-muted-foreground">
              {invoice.number}
            </span>
            <span
              data-invoice-amount
              className={`text-right tabular-nums ${invoice.voided ? 'text-muted-foreground line-through' : 'text-foreground'}`}
            >
              {invoiceAmount(invoice)}
            </span>
            <span className="text-right">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-[9px]" style={{ background: status.color }} />
                <span
                  data-invoice-status
                  className={
                    invoice.paymentStatus === 'failed' && !invoice.voided ? 'text-destructive' : 'text-foreground'
                  }
                >
                  {status.label}
                </span>
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
