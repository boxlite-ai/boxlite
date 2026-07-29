// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Spending from './Spending'

const mocks = vi.hoisted(() => ({
  config: {
    apiUrl: 'http://api.test/api',
    analyticsApiUrl: undefined as string | undefined,
    billingApiUrl: undefined as string | undefined,
  },
  useAggregatedUsage: vi.fn(),
  useBoxesUsage: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ analyticsUsageApi: {} }),
}))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => mocks.config,
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@/hooks/queries/useAnalyticsUsage', () => ({
  useAggregatedUsage: mocks.useAggregatedUsage,
  useBoxesUsage: mocks.useBoxesUsage,
}))

vi.mock('@/hooks/queries/useOrganizationUsageQuery', () => ({
  useOrganizationUsageQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/hooks/queries/usePastOrganizationUsageQuery', () => ({
  usePastOrganizationUsageQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/components/PageLayout', () => {
  const Wrapper = ({ children }: PropsWithChildren) => <>{children}</>
  return {
    PageContent: Wrapper,
    PageHeader: Wrapper,
    PageLayout: Wrapper,
    PageTitle: Wrapper,
  }
})

vi.mock('@/components/spending/AggregatedUsageChart', () => ({
  AggregatedUsageChart: () => null,
  ResourceUsageBreakdown: () => null,
  UsageSummary: ({ isRated }: { isRated?: boolean }) => <div>summary-{isRated ? 'rated' : 'unrated'}</div>,
}))

vi.mock('@/components/spending/CostBreakdown', () => ({
  CostBreakdown: () => <div>cost-breakdown</div>,
}))

vi.mock('@/components/spending/BoxUsageTable', () => ({
  BoxUsageTable: ({ isRated }: { isRated?: boolean }) => <div>table-{isRated ? 'rated' : 'unrated'}</div>,
}))

vi.mock('@/components/ui/date-range-picker', () => ({
  DateRangePicker: () => null,
}))

describe('Spending pricing capabilities', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    mocks.config.analyticsApiUrl = undefined
    mocks.config.billingApiUrl = undefined
    mocks.useAggregatedUsage.mockReturnValue({
      data: { boxCount: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    mocks.useBoxesUsage.mockReturnValue({
      data: [{}],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderSpending(): Promise<void> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<Spending />)
    })
  }

  it('marks built-in analytics as unrated and omits the external billing breakdown', async () => {
    await renderSpending()

    expect(document.body.textContent).toContain('summary-unrated')
    expect(document.body.textContent).toContain('table-unrated')
    expect(document.body.textContent).not.toContain('cost-breakdown')
  })

  it('keeps monetary UI when external analytics and billing are explicitly configured', async () => {
    mocks.config.analyticsApiUrl = 'http://analytics.test'
    mocks.config.billingApiUrl = 'http://billing.test'

    await renderSpending()

    expect(document.body.textContent).toContain('summary-rated')
    expect(document.body.textContent).toContain('table-rated')
    expect(document.body.textContent).toContain('cost-breakdown')
  })
})
