import { describe, expect, it } from 'vitest'
import { MIN_TOP_UP_DOLLARS, topUpGate } from './WalletSection'

describe('topUpGate', () => {
  it('names the missing card rather than leaving the button dead and unexplained', () => {
    expect(topUpGate(false, 100)).toEqual({
      enabled: false,
      reason: 'Connect a payment method above to add funds.',
    })
  })

  it('stays quiet with nothing chosen yet — a disabled button needs no excuse there', () => {
    expect(topUpGate(true, undefined)).toEqual({ enabled: false, reason: null })
    expect(topUpGate(true, 0)).toEqual({ enabled: false, reason: null })
  })

  it('states the minimum instead of letting Commerce reject the round trip', () => {
    expect(topUpGate(true, 5)).toEqual({ enabled: false, reason: 'Minimum top-up is $10.' })
    expect(topUpGate(true, MIN_TOP_UP_DOLLARS - 0.01).reason).toBe('Minimum top-up is $10.')
  })

  it('allows the minimum itself and anything above it', () => {
    expect(topUpGate(true, MIN_TOP_UP_DOLLARS)).toEqual({ enabled: true, reason: null })
    expect(topUpGate(true, 25)).toEqual({ enabled: true, reason: null })
  })

  it('reports the card before the amount — fixing the amount would not unblock anything', () => {
    expect(topUpGate(false, 5).reason).toBe('Connect a payment method above to add funds.')
  })
})
