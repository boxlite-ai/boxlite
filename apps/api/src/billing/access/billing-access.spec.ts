/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { calculateBillingAccess, type BillingAccessInput } from './billing-access'

const now = new Date('2026-07-13T00:00:00.000Z')

function input(overrides: Partial<BillingAccessInput> = {}): BillingAccessInput {
  return {
    freeBalanceCents: '100',
    paidBalanceCents: '0',
    settlementRemainderCents: '0',
    unbilledPeriods: [],
    unsettledRatedCents: [],
    ongoingAllocations: [],
    candidateAllocation: null,
    pricingPlans: [
      {
        version: 1,
        cpuRateCentsPerSec: '1',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    ],
    now,
    riskWindowSeconds: 10,
    ...overrides,
  }
}

describe('calculateBillingAccess', () => {
  it('subtracts unbilled usage, fractional settlement remainder, and the future risk window', () => {
    const result = calculateBillingAccess(
      input({
        settlementRemainderCents: '0.5',
        unbilledPeriods: [
          {
            boxId: 'box-1',
            startAt: new Date('2026-07-12T23:59:50.000Z'),
            endAt: now,
            cpu: 1,
            mem: 0,
            disk: 0,
            gpu: 0,
          },
        ],
        unsettledRatedCents: ['4.5'],
        ongoingAllocations: [{ boxId: 'box-1', cpu: 1, mem: 0, disk: 0, gpu: 0 }],
      }),
    )

    expect(result).toEqual({
      walletBalanceCents: '100',
      unbilledUsageCents: '15',
      safetyBufferCents: '10',
      availableCents: '75',
      hasAccess: true,
    })
  })

  it('blocks when current exposure plus the safety buffer consumes the wallet', () => {
    const result = calculateBillingAccess(
      input({
        freeBalanceCents: '10',
        ongoingAllocations: [{ boxId: 'box-1', cpu: 1, mem: 0, disk: 0, gpu: 0 }],
      }),
    )

    expect(result.availableCents).toBe('0')
    expect(result.hasAccess).toBe(false)
  })

  it('replaces a stopped box disk-only buffer with the full candidate allocation on start', () => {
    const result = calculateBillingAccess(
      input({
        ongoingAllocations: [{ boxId: 'box-1', cpu: 0, mem: 0, disk: 10, gpu: 0 }],
        candidateAllocation: { boxId: 'box-1', cpu: 2, mem: 0, disk: 10, gpu: 0 },
        pricingPlans: [
          {
            version: 1,
            cpuRateCentsPerSec: '1',
            memRateCentsPerSec: '0',
            diskRateCentsPerSec: '0.1',
            gpuRateCentsPerSec: '0',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
          },
        ],
      }),
    )

    expect(result.safetyBufferCents).toBe('30')
    expect(result.availableCents).toBe('70')
  })

  it('fails closed when pricing does not cover the risk window', () => {
    expect(() =>
      calculateBillingAccess(
        input({
          ongoingAllocations: [{ boxId: 'box-1', cpu: 1, mem: 0, disk: 0, gpu: 0 }],
          pricingPlans: [],
        }),
      ),
    ).toThrow('pricing gap')
  })
})
