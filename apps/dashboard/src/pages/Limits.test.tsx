// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const billingMock = vi.hoisted(() => ({
  tier: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  wallet: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  tiers: { data: [], isLoading: false, isError: false, refetch: vi.fn() },
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerTierQuery: () => billingMock.tier,
  useOwnerWalletQuery: () => billingMock.wallet,
}))
vi.mock('@/hooks/queries/useTiersQuery', () => ({ useTiersQuery: () => billingMock.tiers }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: '', rateLimit: {} }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1', defaultRegionId: 'eu' } }),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: {} } }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

// PageLayout reaches for BannerProvider; the chrome is irrelevant here.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}))

// Stand-in so the assertion is about *placement* — that the card is rendered at
// all — rather than about anything inside it.
vi.mock('@/components/CurrentUsageCard', () => ({
  CurrentUsageCard: () => <div data-testid="current-usage-card" />,
}))

import Limits from './Limits'

describe('Limits', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    billingMock.tier.isError = false
    billingMock.wallet.isError = false
    billingMock.tiers.isError = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const render = () => act(() => root.render(<Limits />))

  it('shows current usage when billing data loads', () => {
    render()

    expect(container.querySelector('[data-testid="current-usage-card"]')).not.toBeNull()
  })

  // Quota usage comes from the core API. A deployment with no billing API errors
  // these queries, and before this it blanked the whole page — including limits
  // that have nothing to do with billing.
  it('still shows current usage when the billing queries fail', () => {
    billingMock.tier.isError = true
    billingMock.wallet.isError = true

    render()

    expect(container.textContent).toContain('Oops, something went wrong')
    expect(container.querySelector('[data-testid="current-usage-card"]')).not.toBeNull()
  })
})
