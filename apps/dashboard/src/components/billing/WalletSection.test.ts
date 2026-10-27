import { describe, expect, it } from 'vitest'
import { MIN_TOP_UP_DOLLARS, topUpDiscountPercent, topUpGate } from './WalletSection'

describe('topUpGate', () => {
  it('allows a top-up without a saved card so Checkout can collect one', () => {
    expect(topUpGate(100)).toEqual({ enabled: true, reason: null })
  })

  it('stays quiet with nothing chosen yet — a disabled button needs no excuse there', () => {
    expect(topUpGate(undefined)).toEqual({ enabled: false, reason: null })
    expect(topUpGate(0)).toEqual({ enabled: false, reason: null })
  })

  it('states the minimum instead of letting Commerce reject the round trip', () => {
    expect(topUpGate(5)).toEqual({ enabled: false, reason: 'Minimum top-up is $10.' })
    expect(topUpGate(MIN_TOP_UP_DOLLARS - 0.01).reason).toBe('Minimum top-up is $10.')
  })

  it('allows the minimum itself and anything above it', () => {
    expect(topUpGate(MIN_TOP_UP_DOLLARS)).toEqual({ enabled: true, reason: null })
    expect(topUpGate(25)).toEqual({ enabled: true, reason: null })
  })
})

describe('topUpDiscountPercent', () => {
  it('reads a multiplier below 1 as the share a top-up is discounted by', () => {
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.7000' })).toBe('30%')
  })

  it('counts in basis points, where flooring a float loses a whole percent', () => {
    // Math.floor((1 - 0.8) * 100) is 19, and Math.floor((1 - 0.55) * 100) is 44.
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.8000' })).toBe('20%')
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.5500' })).toBe('45%')
  })

  it('rounds a fractional discount down, never promising more than is taken off', () => {
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.8765' })).toBe('12%')
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.875' })).toBe('12%')
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.0001' })).toBe('99%')
  })

  it('shows no discount at 1, under 1%, or when the billing API predates the field', () => {
    expect(topUpDiscountPercent({ usageChargeMultiplier: '1.0000' })).toBeNull()
    expect(topUpDiscountPercent({ usageChargeMultiplier: '1' })).toBeNull()
    expect(topUpDiscountPercent({ usageChargeMultiplier: '0.9950' })).toBeNull()
    expect(topUpDiscountPercent({})).toBeNull()
  })

  it('shows no discount for malformed or out-of-range text', () => {
    for (const usageChargeMultiplier of ['', 'abc', '0.0000', '1.5000', '-0.5000', '0.12345', '0.8e0']) {
      expect(topUpDiscountPercent({ usageChargeMultiplier })).toBeNull()
    }
  })
})
