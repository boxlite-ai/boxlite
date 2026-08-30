/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { WalletTransaction } from '@/billing-api'
import type { WalletTransactionsTableProps } from './types'
import { walletTransactionLabel } from './columns'

const ROW = 'grid grid-cols-[100px_110px_1fr_90px_80px] items-center gap-x-4'

const STATUS = {
  settled: { label: 'ok', color: 'hsl(var(--success))' },
  pending: { label: 'pending', color: 'hsl(var(--warning))' },
  failed: { label: 'failed', color: 'hsl(var(--destructive))' },
} as const

function transactionDate(transaction: WalletTransaction): string {
  return transaction.createdAt.slice(0, 10)
}

function transactionAmount(transaction: WalletTransaction): string {
  const prefix = transaction.direction === 'inbound' ? '+' : '-'
  return `${prefix}${(transaction.amountCents / 100).toFixed(2)}`
}

export function WalletTransactionsTable({ data, loading }: WalletTransactionsTableProps) {
  if (loading) {
    return <div className="border-b border-border/40 py-[13px] font-mono text-[13px]">Loading...</div>
  }

  return (
    <div>
      <div
        className={`${ROW} border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`}
      >
        <span data-transaction-header>Date</span>
        <span data-transaction-header>Type</span>
        <span data-transaction-header />
        <span data-transaction-header className="text-right">
          Amount
        </span>
        <span data-transaction-header className="text-right">
          Status
        </span>
      </div>
      {data.map((transaction) => {
        const status = STATUS[transaction.status]
        return (
          <div
            key={transaction.id}
            className={`${ROW} border-b border-border/40 py-[13px] font-mono text-[13px] transition-colors hover:bg-muted/30`}
          >
            <span data-transaction-date className="text-foreground">
              {transactionDate(transaction)}
            </span>
            <span data-transaction-type className="uppercase tracking-[0.5px] text-muted-foreground">
              {walletTransactionLabel(transaction).toLowerCase()}
            </span>
            <span />
            <span
              data-transaction-amount
              className={`text-right tabular-nums ${transaction.direction === 'inbound' ? 'text-success' : 'text-foreground'}`}
            >
              {transactionAmount(transaction)}
            </span>
            <span className="text-right">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-[9px]" style={{ background: status.color }} />
                <span
                  data-transaction-status
                  className={transaction.status === 'failed' ? 'text-destructive' : 'text-foreground'}
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
