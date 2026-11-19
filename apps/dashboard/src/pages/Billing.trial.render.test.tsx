// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import Billing from './Billing'

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }),
}))
vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerPlanQuery: () => ({
    data: {
      planId: 'pro',
      planName: 'Pro',
      status: 'active',
      cycleFrom: new Date('2026-08-01T00:00:00.000Z'),
      cycleTo: new Date('2026-08-07T00:00:00.000Z'),
      includedQuotaCents: 25_000,
      quotaConsumedCents: 0,
      quotaRemainingCents: 25_000,
      trial: {
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-07T00:00:00.000Z'),
        conversionAmountCents: 14_900,
        currency: 'USD',
        conversionState: 'not_attempted',
      },
    },
    isError: false,
  }),
  useOwnerWalletQuery: () => ({
    data: {
      name: 'Test',
      balanceCents: 2_000,
      ongoingBalanceCents: 1_000,
      creditCardConnected: true,
    },
    isError: false,
  }),
}))
vi.mock('@/hooks/queries/usePlansQuery', () => ({
  usePlansQuery: () => ({
    data: [
      {
        id: 'pro',
        name: 'Pro',
        priceMonthlyCents: 14_900,
        includedQuotaCents: 25_000,
        concurrencyLimit: 100,
        selfServe: true,
      },
    ],
    isError: false,
  }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserOrganizationMember: { role: OrganizationUserRoleEnum.OWNER },
  }),
}))
vi.mock('@/components/billing/BillingAlerts', () => ({ BillingAlerts: () => null }))
vi.mock('@/components/billing/BalanceLowBanner', () => ({ BalanceLowBanner: () => null }))
vi.mock('@/components/billing/PlansSection', () => ({ PlansSection: () => null }))
vi.mock('@/components/billing/UsageSection', () => ({ UsageSection: () => <div>Usage section</div> }))
vi.mock('@/components/billing/WalletSection', () => ({ WalletSection: () => null }))

describe('Billing trial overview', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('shows the trial countdown on the default Overview tab', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'))
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/billing']}>
          <Billing />
        </MemoryRouter>,
      )
    })

    expect(host.textContent).toContain('Active Plan')
    expect(host.textContent).toContain('Pro$149/mo')
    expect(host.textContent).toMatch(/FREE TRIAL\s*·\s*3\s*days\s*left/)
    expect(host.textContent).not.toContain('Usage section')
  })
})
