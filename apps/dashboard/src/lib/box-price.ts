/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { UsagePriceCode, UsagePrices } from '@/billing-api'
import { formatMoney } from '@/lib/utils'

/**
 * Turns Commerce's published unit prices into the hourly figure the create-box
 * dialog quotes, alongside the per-resource lines that add up to it.
 *
 * Both of Commerce's rate units are per hour (`core_hour`, `gib_hour`), so this
 * is a multiply — no unit conversion, and deliberately no attempt to model
 * running-versus-suspended metering. The dialog quotes the cost of a box that
 * runs for an hour; what the account is actually charged is settled by Commerce.
 */

export interface BoxSpec {
  /** vCPU. */
  cpu: number
  /** GiB. */
  memory: number
  /** GiB. */
  disk: number
}

export interface BoxPriceLine {
  code: UsagePriceCode
  label: string
  quantity: number
  /** Unit the quantity is counted in — the price is per one of these per hour. */
  quantityUnit: string
  unitPriceCents: number
  subtotalCents: number
}

export interface BoxHourlyPrice {
  lines: BoxPriceLine[]
  totalCents: number
}

/**
 * The resources a box created from this dialog consumes. Commerce also prices
 * `gpu`, which is left out on purpose: the dialog offers no GPU control, so
 * quoting a GPU line would invent a charge the box cannot incur.
 */
const QUOTED_RESOURCES: ReadonlyArray<{
  code: UsagePriceCode
  label: string
  quantityUnit: string
  quantityOf: (spec: BoxSpec) => number
}> = [
  { code: 'cpu', label: 'CPU', quantityUnit: 'vCPU', quantityOf: (spec) => spec.cpu },
  { code: 'mem', label: 'Memory', quantityUnit: 'GiB', quantityOf: (spec) => spec.memory },
  { code: 'disk', label: 'Disk', quantityUnit: 'GiB', quantityOf: (spec) => spec.disk },
]

/**
 * `null` when the quote cannot be made honestly — no price list, or a list
 * missing one of the three resources. Dropping an unpriced resource and
 * totalling the rest would understate the box, which is worse than declining to
 * quote, so one gap voids the whole estimate.
 */
export function boxHourlyPrice(prices: UsagePrices | undefined | null, spec: BoxSpec): BoxHourlyPrice | null {
  if (!prices) {
    return null
  }

  const lines: BoxPriceLine[] = []
  for (const resource of QUOTED_RESOURCES) {
    const published = prices.prices.find((price) => price.code === resource.code)
    if (!published || !Number.isFinite(published.unitPriceCents)) {
      return null
    }

    const quantity = resource.quantityOf(spec)
    lines.push({
      code: resource.code,
      label: resource.label,
      quantity,
      quantityUnit: resource.quantityUnit,
      unitPriceCents: published.unitPriceCents,
      subtotalCents: quantity * published.unitPriceCents,
    })
  }

  return {
    lines,
    totalCents: lines.reduce((total, line) => total + line.subtotalCents, 0),
  }
}

/**
 * Commerce's cents are fractional — disk is `0.018` of a cent — so the
 * two-decimal money formatting used for balances and invoices renders every
 * disk figure as $0.00. Prices need the extra places.
 */
export function formatPriceCents(cents: number, maximumFractionDigits = 4): string {
  return formatMoney(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits })
}
