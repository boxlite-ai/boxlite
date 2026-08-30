/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Invoice } from '@/billing-api/types/Invoice'
import { StatusMark } from '@/components/ascii'
import { ArrowDown, ArrowUp } from '@/components/ui/icon'
import { formatAmount } from '@/lib/utils'
import { ColumnDef } from '@tanstack/react-table'
import React from 'react'

interface SortableHeaderProps {
  column: any
  label: string
  dataState?: string
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ column, label, dataState }) => (
  <div
    role="button"
    onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
    className="flex items-center"
    {...(dataState && { 'data-state': dataState })}
  >
    {label}
    {column.getIsSorted() === 'asc' ? (
      <ArrowUp className="ml-2 size-4" />
    ) : column.getIsSorted() === 'desc' ? (
      <ArrowDown className="ml-2 size-4" />
    ) : (
      <div className="ml-2 size-4" />
    )}
  </div>
)

export function getColumns(): ColumnDef<Invoice>[] {
  return [
    {
      id: 'number',
      header: ({ column }) => <SortableHeader column={column} label="Settlement" />,
      accessorKey: 'number',
      cell: ({ row }) => <span className="font-medium">{row.original.number || `#${row.original.sequentialId}`}</span>,
      sortingFn: (rowA, rowB) => rowA.original.sequentialId - rowB.original.sequentialId,
    },
    {
      id: 'chargedAt',
      size: 160,
      header: ({ column }) => <SortableHeader column={column} label="Charged" />,
      cell: ({ row }) => (
        <span>
          {new Date(row.original.chargedAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      ),
      accessorFn: (row) => new Date(row.chargedAt).getTime(),
    },
    {
      id: 'totalAmountCents',
      size: 120,
      header: ({ column }) => <SortableHeader column={column} label="Cost" />,
      cell: ({ row }) => <span>{formatAmount(row.original.totalAmountCents)}</span>,
      accessorKey: 'totalAmountCents',
    },
    {
      id: 'quotaCoveredCents',
      size: 140,
      header: ({ column }) => <SortableHeader column={column} label="From quota" />,
      cell: ({ row }) => <span>{formatAmount(row.original.quotaCoveredCents)}</span>,
      accessorKey: 'quotaCoveredCents',
    },
    {
      id: 'walletFundedCents',
      size: 140,
      header: ({ column }) => <SortableHeader column={column} label="From wallet" />,
      cell: ({ row }) => <span>{formatAmount(row.original.totalAmountCents - row.original.quotaCoveredCents)}</span>,
      accessorFn: (row) => row.totalAmountCents - row.quotaCoveredCents,
    },
    {
      id: 'voided',
      size: 110,
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      cell: ({ row }) =>
        row.original.voided ? <StatusMark tone="idle">Voided</StatusMark> : <StatusMark tone="ok">Settled</StatusMark>,
      accessorKey: 'voided',
    },
  ]
}
