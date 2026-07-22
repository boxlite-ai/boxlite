/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Decimal from 'decimal.js'
import type { ResourceCosts } from '../rating/rate-math'
import type { ResourceMultipliers } from './subscription.types'

export interface SegmentSettlementInput {
  resourceCosts: ResourceCosts
  overageMultipliers: ResourceMultipliers
  quotaAvailablePreciseCents: string
}

export interface SegmentSettlementResult {
  quotaCoveredPreciseCents: string
  overagePreciseCents: string
  chargePreciseCents: string
}

export function applyResourceMultipliers(costs: ResourceCosts, multipliers: ResourceMultipliers): ResourceCosts {
  return {
    cpuCents: multiply(costs.cpuCents, multipliers.cpu, 'cpu'),
    memCents: multiply(costs.memCents, multipliers.mem, 'memory'),
    diskCents: multiply(costs.diskCents, multipliers.disk, 'disk'),
    gpuCents: multiply(costs.gpuCents, multipliers.gpu, 'gpu'),
  }
}

export function sumResourceCosts(costs: ResourceCosts): Decimal {
  return new Decimal(costs.cpuCents).plus(costs.memCents).plus(costs.diskCents).plus(costs.gpuCents)
}

export function settleSegmentAgainstQuota(input: SegmentSettlementInput): SegmentSettlementResult {
  const ratedPrecise = sumResourceCosts(input.resourceCosts)
  const available = nonNegativeDecimal(input.quotaAvailablePreciseCents, 'quota available')
  const quotaCovered = Decimal.min(ratedPrecise, available)
  if (ratedPrecise.isZero()) {
    return { quotaCoveredPreciseCents: '0', overagePreciseCents: '0', chargePreciseCents: '0' }
  }

  const uncoveredRatio = ratedPrecise.minus(quotaCovered).div(ratedPrecise)
  const overagePrecise = sumResourceCosts(applyResourceMultipliers(input.resourceCosts, input.overageMultipliers)).mul(
    uncoveredRatio,
  )
  return {
    quotaCoveredPreciseCents: quotaCovered.toString(),
    overagePreciseCents: overagePrecise.toString(),
    chargePreciseCents: overagePrecise.toString(),
  }
}

function multiply(value: string, multiplier: string, resource: string): string {
  const factor = new Decimal(multiplier)
  if (factor.isNegative()) throw new Error(`${resource} multiplier must be non-negative`)
  return new Decimal(value).mul(factor).toString()
}

function nonNegativeDecimal(value: string, name: string): Decimal {
  const parsed = new Decimal(value)
  if (parsed.isNegative()) throw new Error(`${name} must be non-negative`)
  return parsed
}
