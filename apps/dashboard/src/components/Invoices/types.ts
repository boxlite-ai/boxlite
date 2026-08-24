/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Invoice } from '@/billing-api'
import { Table } from '@tanstack/react-table'

export interface InvoicesTableProps {
  data: Invoice[]
  totalItems: number
  pagination: {
    pageIndex: number
    pageSize: number
  }
  pageCount: number
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
  loading: boolean
}

export interface InvoicesTableHeaderProps {
  table: Table<Invoice>
}
