import { describe, expect, it } from 'vitest'

import type { UsagePrices } from '@/billing-api'
import { boxHourlyPrice, formatPriceCents } from './box-price'

// The live dev response from Commerce, verbatim — fractional cents included.
const prices: UsagePrices = {
  schemaVersion: 1,
  currency: 'USD',
  prices: [
    { code: 'cpu', unit: 'core_hour', unitPriceCents: 5.04 },
    { code: 'gpu', unit: 'gpu_hour', unitPriceCents: 100 },
    { code: 'mem', unit: 'gib_hour', unitPriceCents: 1.44 },
    { code: 'disk', unit: 'gib_hour', unitPriceCents: 0.018 },
  ],
}

const small = { cpu: 1, memory: 1, disk: 10 }

describe('boxHourlyPrice', () => {
  it('totals the published rates for the box being created', () => {
    const quote = boxHourlyPrice(prices, small)

    // 1 × 5.04¢ + 1 × 1.44¢ + 10 × 0.018¢
    expect(quote?.totalCents).toBeCloseTo(6.66, 10)
    expect(quote?.lines.map((line) => line.label)).toEqual(['CPU', 'Memory', 'Disk'])
    expect(quote?.lines.map((line) => line.subtotalCents)).toEqual([
      expect.closeTo(5.04, 10),
      expect.closeTo(1.44, 10),
      expect.closeTo(0.18, 10),
    ])
  })

  it('scales every line with the resource it prices', () => {
    const quote = boxHourlyPrice(prices, { cpu: 4, memory: 8, disk: 50 })

    expect(quote?.lines.map((line) => line.quantity)).toEqual([4, 8, 50])
    expect(quote?.totalCents).toBeCloseTo(4 * 5.04 + 8 * 1.44 + 50 * 0.018, 10)
  })

  it('leaves GPU out — the dialog cannot ask for one, so it cannot be charged for one', () => {
    expect(boxHourlyPrice(prices, small)?.lines.map((line) => line.code)).toEqual(['cpu', 'mem', 'disk'])
  })

  it('declines to quote at all when a resource has no published price', () => {
    const withoutDisk = { ...prices, prices: prices.prices.filter((price) => price.code !== 'disk') }

    // Not "CPU + memory only": a partial total understates the box.
    expect(boxHourlyPrice(withoutDisk, small)).toBeNull()
  })

  it('declines to quote on a non-finite rate rather than propagating NaN into the total', () => {
    const broken = {
      ...prices,
      prices: prices.prices.map((price) => (price.code === 'mem' ? { ...price, unitPriceCents: NaN } : price)),
    }

    expect(boxHourlyPrice(broken, small)).toBeNull()
  })

  it('declines to quote without a price list', () => {
    expect(boxHourlyPrice(undefined, small)).toBeNull()
    expect(boxHourlyPrice(null, small)).toBeNull()
  })
})

describe('formatPriceCents', () => {
  it('keeps a fractional-cent rate visible instead of rounding it to $0.00', () => {
    // 0.018¢ is the disk rate; the two-decimal money formatter renders it $0.00.
    expect(formatPriceCents(0.018, 6)).toBe('$0.00018')
    expect(formatPriceCents(5.04, 6)).toBe('$0.0504')
  })

  it('shows an hourly total to four places, where a small box is not $0.00', () => {
    expect(formatPriceCents(6.66)).toBe('$0.0666')
  })

  it('still reads as ordinary money once the amount is large enough', () => {
    expect(formatPriceCents(100)).toBe('$1.00')
  })
})
