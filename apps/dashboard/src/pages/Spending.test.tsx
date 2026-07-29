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
  useAggregatedUsage: vi.fn(),
  useBoxesUsage: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ analyticsUsageApi: {} }),
}))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'http://api.test/api', analyticsApiUrl: undefined }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('posthog-js/react', () => ({
  useFeatureFlagEnabled: () => false,
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
  UsageSummary: () => null,
}))

vi.mock('@/components/spending/CostBreakdown', () => ({
  CostBreakdown: () => null,
}))

vi.mock('@/components/spending/BoxUsageTable', () => ({
  BoxUsageTable: () => null,
}))

vi.mock('@/components/ui/date-range-picker', () => ({
  DateRangePicker: () => null,
}))

describe('Spending built-in usage', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
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

  it('shows and requests resource usage without an external analytics URL', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<Spending />)
    })

    expect(mocks.useAggregatedUsage).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    expect(mocks.useBoxesUsage).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    expect(document.body.textContent).toContain('Resource Usage')
  })
})
