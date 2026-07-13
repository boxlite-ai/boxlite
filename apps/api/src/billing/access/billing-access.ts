/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Decimal from 'decimal.js'
import { ratePeriodByPlans, type PricingPlanSnapshot, type RateableUsagePeriod } from '../rating/rate-math'

export interface BillingAllocation {
  boxId: string
  cpu: number
  mem: number
  disk: number
  gpu: number
}

export interface UnbilledUsagePeriod extends RateableUsagePeriod {
  boxId: string
}

export interface BillingAccessInput {
  freeBalanceCents: string
  paidBalanceCents: string
  settlementRemainderCents: string
  unbilledPeriods: UnbilledUsagePeriod[]
  unsettledRatedCents: string[]
  ongoingAllocations: BillingAllocation[]
  candidateAllocation: BillingAllocation | null
  pricingPlans: PricingPlanSnapshot[]
  now: Date
  riskWindowSeconds: number
}

export interface BillingAccessResult {
  walletBalanceCents: string
  unbilledUsageCents: string
  safetyBufferCents: string
  availableCents: string
  hasAccess: boolean
}

export function calculateBillingAccess(input: BillingAccessInput): BillingAccessResult {
  if (!Number.isFinite(input.riskWindowSeconds) || input.riskWindowSeconds < 0) {
    throw new Error('billing enforcement risk window must be a finite non-negative number')
  }

  const walletBalance = new Decimal(input.freeBalanceCents).plus(input.paidBalanceCents)
  const unbilledUsage = input.unbilledPeriods
    .reduce(
      (total, period) => total.plus(ratePeriodByPlans(period, input.pricingPlans).preciseCents),
      new Decimal(input.settlementRemainderCents),
    )
    .plus(input.unsettledRatedCents.reduce((total, cents) => total.plus(cents), new Decimal(0)))

  const allocations = new Map(input.ongoingAllocations.map((allocation) => [allocation.boxId, allocation]))
  if (input.candidateAllocation) {
    allocations.set(input.candidateAllocation.boxId, input.candidateAllocation)
  }

  const riskEnd = new Date(input.now.getTime() + input.riskWindowSeconds * 1000)
  const safetyBuffer = [...allocations.values()].reduce(
    (total, allocation) =>
      total.plus(
        ratePeriodByPlans(
          {
            startAt: input.now,
            endAt: riskEnd,
            cpu: allocation.cpu,
            mem: allocation.mem,
            disk: allocation.disk,
            gpu: allocation.gpu,
          },
          input.pricingPlans,
        ).preciseCents,
      ),
    new Decimal(0),
  )
  const available = walletBalance.minus(unbilledUsage).minus(safetyBuffer)

  return {
    walletBalanceCents: walletBalance.toString(),
    unbilledUsageCents: unbilledUsage.toString(),
    safetyBufferCents: safetyBuffer.toString(),
    availableCents: available.toString(),
    hasAccess: available.greaterThan(0),
  }
}
