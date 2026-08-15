import { describe, expect, it } from 'vitest'
import { lowBalance } from './BalanceLowBanner'

const autoTopUp = { thresholdAmount: 20, targetAmount: 100 }

describe('lowBalance', () => {
  it('fires below the configured threshold (dollars) against the balance (cents)', () => {
    expect(lowBalance({ ongoingBalanceCents: 1_999, automaticTopUp: autoTopUp })).toEqual({
      thresholdDollars: 20,
      targetDollars: 100,
    })
  })

  it('stays silent at or above the threshold', () => {
    expect(lowBalance({ ongoingBalanceCents: 2_000, automaticTopUp: autoTopUp })).toBeNull()
    expect(lowBalance({ ongoingBalanceCents: 8_750, automaticTopUp: autoTopUp })).toBeNull()
  })

  it('stays silent with no auto-reload configured — there is no threshold to compare', () => {
    expect(lowBalance({ ongoingBalanceCents: -500 })).toBeNull()
    expect(lowBalance(undefined)).toBeNull()
  })

  it('treats a zeroed threshold as disabled, the WalletSection convention', () => {
    expect(
      lowBalance({ ongoingBalanceCents: -500, automaticTopUp: { thresholdAmount: 0, targetAmount: 0 } }),
    ).toBeNull()
  })
})
