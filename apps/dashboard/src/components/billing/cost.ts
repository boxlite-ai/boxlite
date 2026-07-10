/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingPricing } from '@/billing-api'
import Decimal from 'decimal.js'

export interface BoxResources {
  cpu: number
  memory: number
  disk: number
  gpu?: number
}

export function calculateBoxHourlyCost(pricing: BillingPricing, resources: BoxResources) {
  const cpuCents = new Decimal(pricing.cpuRateCentsPerHour).mul(resources.cpu)
  const memoryCents = new Decimal(pricing.memRateCentsPerHour).mul(resources.memory)
  const diskCents = new Decimal(pricing.diskRateCentsPerHour).mul(resources.disk)
  const gpuCents = new Decimal(pricing.gpuRateCentsPerHour).mul(resources.gpu ?? 0)

  return {
    cpuCents: cpuCents.toString(),
    memoryCents: memoryCents.toString(),
    diskCents: diskCents.toString(),
    gpuCents: gpuCents.toString(),
    totalCents: cpuCents.plus(memoryCents).plus(diskCents).plus(gpuCents).toString(),
  }
}

export function formatUsdFromCents(cents: string, decimalPlaces = 2): string {
  return `$${new Decimal(cents).div(100).toFixed(decimalPlaces)}`
}
