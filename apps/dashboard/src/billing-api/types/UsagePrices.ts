/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Commerce's published display prices (`GET /usage-prices`, anonymous).
 *
 * Commerce projects these from the rates it loaded at boot and states in the
 * same breath that settlement, not this response, is the authority for what is
 * actually charged — so anything rendered from it is an estimate.
 */
export type UsagePriceCode = 'cpu' | 'gpu' | 'mem' | 'disk'

export type UsagePriceUnit = 'core_hour' | 'gpu_hour' | 'gib_hour'

export interface UsagePriceItem {
  code: UsagePriceCode
  unit: UsagePriceUnit
  /**
   * USD cents per unit-hour, **fractional**: disk ships as `0.018`, not an
   * integer. Formatters that assume whole cents round every disk figure to
   * $0.00.
   */
  unitPriceCents: number
}

export interface UsagePrices {
  /** Shape of this response, not a version of the prices it carries. */
  schemaVersion: number
  currency: string
  prices: UsagePriceItem[]
}
