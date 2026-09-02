/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { WalletTransaction } from '@/billing-api'

export interface WalletTransactionsTableProps {
  data: WalletTransaction[]
  loading: boolean
}
