// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrganizationPlan } from '@/billing-api'
import { ThisCycleCard } from './ThisCycleCard'

const plan: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active' as const,
  cycleFrom: new Date('2026-08-05T12:00:00.000Z'),
  cycleTo: new Date('2026-09-05T12:00:00.000Z'),
  includedQuotaCents: 25_000,
  quotaConsumedCents: 6_250,
  quotaRemainingCents: 18_750,
}

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerPlanQuery: () => ({ data: plan, isLoading: false }),
  useOwnerWalletQuery: () => ({ data: undefined }),
}))

vi.mock('@/hooks/queries/usePlansQuery', () => ({
  usePlansQuery: () => ({ data: undefined }),
}))

vi.mock('@/hooks/queries/useRunningBoxCountQuery', () => ({
  useRunningBoxCountQuery: () => ({ data: undefined }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))

describe('ThisCycleCard quota summary', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    delete plan.trial
    vi.useRealTimers()
  })

  it('renders quota remaining from the plan response', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(<ThisCycleCard />)
    })

    const label = [...document.querySelectorAll('span')].find((element) =>
      element.textContent?.includes('Quota Remaining'),
    )

    expect(label).toBeDefined()
    expect(label?.parentElement?.textContent).toContain('$187.50')
    expect(label?.parentElement?.textContent).not.toContain('$62.50')
    expect(document.body.textContent).not.toContain('Quota consumed')
  })

  it('trial countdown renders the trial deadline instead of the monthly cycle', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    plan.trial = {
      startedAt: new Date('2026-08-05T12:00:00.000Z'),
      endsAt: new Date('2026-08-17T12:00:00.000Z'),
      conversionAmountCents: 14900,
      currency: 'USD',
      conversionState: 'not_attempted',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(<ThisCycleCard />)
    })

    expect(document.body.textContent).toContain('Pro · Aug 5 – Aug 17')
    expect(document.body.textContent).toMatch(/Free trial ends in\s*3\s*days/)
    expect(document.body.textContent).not.toContain('Cycle ends in')
  })
})
