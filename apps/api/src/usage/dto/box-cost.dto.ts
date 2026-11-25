/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export type BoxCostLineDto = {
  item: string
  quantity: string
  unit: string
  amount_usd: string
  start: string
  end: string
}

export type BoxCostDto = {
  box_id: string
  status: 'accruing' | 'final'
  source: 'calculated'
  total_usd: string | null
  lines: BoxCostLineDto[]
  as_of: string
}
