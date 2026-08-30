import { describe, expect, it } from 'vitest'
import { MIN_TOP_UP_DOLLARS, topUpGate } from './WalletSection'

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
