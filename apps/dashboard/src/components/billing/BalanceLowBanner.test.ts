import type { OrganizationPlan, OrganizationWallet } from '@/billing-api'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { balanceWarning, BalanceLowBanner } from './BalanceLowBanner'

const queryMocks = vi.hoisted(() => ({
  plan: undefined as OrganizationPlan | undefined,
  wallet: undefined as OrganizationWallet | undefined,
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerPlanQuery: () => ({ data: queryMocks.plan }),
  useOwnerWalletQuery: () => ({ data: queryMocks.wallet }),
}))

const autoTopUp = { thresholdAmount: 20, targetAmount: 100 }
const spentQuota = { quotaRemainingCents: 0 }

describe('balanceWarning', () => {
  it('fires below the configured threshold (dollars) against the balance (cents)', () => {
    expect(balanceWarning({ ongoingBalanceCents: 1_999, automaticTopUp: autoTopUp })).toEqual({
      level: 'below-threshold',
      thresholdDollars: 20,
      targetDollars: 100,
    })
  })

  it('stays silent at or above the threshold', () => {
    expect(balanceWarning({ ongoingBalanceCents: 2_000, automaticTopUp: autoTopUp })).toBeNull()
    expect(balanceWarning({ ongoingBalanceCents: 8_750, automaticTopUp: autoTopUp })).toBeNull()
  })

  it('warns on a negative balance even with no auto-reload to compare against', () => {
    // The reload threshold lives behind a linked card, so requiring one here is
    // what let an unlinked account run negative in silence.
    expect(balanceWarning({ ongoingBalanceCents: -3 })).toEqual({ level: 'overdrawn' })
    expect(
      balanceWarning({ ongoingBalanceCents: -500, automaticTopUp: { thresholdAmount: 0, targetAmount: 0 } }),
    ).toEqual({ level: 'overdrawn' })
  })

  it('warns on an empty wallet once quota is spent', () => {
    expect(balanceWarning({ ongoingBalanceCents: 0 }, spentQuota)).toEqual({ level: 'empty' })
  })

  it('stays quiet on an empty wallet that quota still stands in front of', () => {
    // A funded plan is *expected* to sit at $0 wallet; warning there is noise.
    expect(balanceWarning({ ongoingBalanceCents: 0 }, { quotaRemainingCents: 18_750 })).toBeNull()
  })

  it('reads a null quota remaining as an unlimited grant, not an exhausted one', () => {
    expect(balanceWarning({ ongoingBalanceCents: 0 }, { quotaRemainingCents: null })).toBeNull()
  })

  it('warns on an empty wallet when there is no plan at all', () => {
    expect(balanceWarning({ ongoingBalanceCents: 0 })).toEqual({ level: 'empty' })
  })

  it('does not let leftover quota excuse a draw that already happened', () => {
    expect(balanceWarning({ ongoingBalanceCents: -3 }, { quotaRemainingCents: 18_750 })).toEqual({
      level: 'overdrawn',
    })
  })

  it('stays silent without a wallet', () => {
    expect(balanceWarning(undefined)).toBeNull()
  })
})

describe('BalanceLowBanner placement', () => {
  beforeEach(() => {
    queryMocks.plan = undefined
    queryMocks.wallet = undefined
  })

  it('keeps below-threshold warnings out of the page-level banner', () => {
    queryMocks.wallet = {
      ongoingBalanceCents: 1_999,
      automaticTopUp: autoTopUp,
    } as OrganizationWallet

    expect(renderToStaticMarkup(createElement(BalanceLowBanner, { onGoToWallet: vi.fn() }))).toBe('')
  })

  it('keeps overdrawn and empty warnings in the page-level banner', () => {
    queryMocks.wallet = { ongoingBalanceCents: -1 } as OrganizationWallet
    expect(renderToStaticMarkup(createElement(BalanceLowBanner, { onGoToWallet: vi.fn() }))).toContain(
      'Wallet overdrawn',
    )

    queryMocks.wallet = { ongoingBalanceCents: 0 } as OrganizationWallet
    queryMocks.plan = { quotaRemainingCents: 0 } as OrganizationPlan
    expect(renderToStaticMarkup(createElement(BalanceLowBanner, { onGoToWallet: vi.fn() }))).toContain('Wallet empty')
  })
})
