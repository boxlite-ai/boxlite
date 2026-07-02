import { describe, expect, it } from 'vitest'
import {
  calculateUsageDelta,
  formatUsageSeconds,
  formatUsageTimestamp,
  type BoxUsageTotals,
} from './usage-verification'

describe('usage verification helpers', () => {
  it('formats usage seconds with useful precision', () => {
    expect(formatUsageSeconds(undefined)).toBe('-')
    expect(formatUsageSeconds(90.21)).toBe('90.21')
    expect(formatUsageSeconds(158.844)).toBe('158.8')
  })

  it('calculates non-negative deltas between usage samples', () => {
    const previous: BoxUsageTotals = {
      boxId: 'box-1',
      totalCPUSeconds: 10,
      totalRAMGBSeconds: 12,
      totalDiskGBSeconds: 20,
      totalGPUSeconds: 0,
    }
    const current: BoxUsageTotals = {
      boxId: 'box-1',
      totalCPUSeconds: 17.5,
      totalRAMGBSeconds: 18,
      totalDiskGBSeconds: 42,
      totalGPUSeconds: 0,
    }

    expect(calculateUsageDelta(current, previous)).toEqual({
      cpu: 7.5,
      ram: 6,
      disk: 22,
      gpu: 0,
    })
    expect(calculateUsageDelta(previous, current).cpu).toBe(0)
  })

  it('formats raw period timestamps for compact table display', () => {
    expect(formatUsageTimestamp('2026-06-25T12:00:00.000Z')).toBe('2026-06-25 12:00:00Z')
    expect(formatUsageTimestamp(null)).toBe('NULL')
    expect(formatUsageTimestamp('not-a-date')).toBe('not-a-date')
  })
})
