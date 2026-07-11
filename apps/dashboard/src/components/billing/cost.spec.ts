/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { calculateBoxHourlyCost, formatUsdFromCents } from './cost'
import { describe, expect, it } from 'vitest'

const pricing = {
  version: 1,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  cpuRateCentsPerHour: '5.04',
  memRateCentsPerHour: '1.62',
  diskRateCentsPerHour: '0.0108',
  gpuRateCentsPerHour: '0',
}

describe('calculateBoxHourlyCost', () => {
  it('uses every current resource rate without rounding intermediate values', () => {
    expect(calculateBoxHourlyCost(pricing, { cpu: 1, memory: 2, disk: 10, gpu: 0 })).toEqual({
      cpuCents: '5.04',
      memoryCents: '3.24',
      diskCents: '0.108',
      gpuCents: '0',
      totalCents: '8.388',
    })
    expect(formatUsdFromCents('8.388', 5)).toBe('$0.08388')
  })
})
