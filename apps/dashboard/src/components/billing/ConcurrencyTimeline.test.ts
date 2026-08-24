// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  concurrencyQuery: vi.fn(),
  ownerPlanQuery: vi.fn(),
  plansQuery: vi.fn(),
  planConcurrencyLimit: vi.fn(),
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerConcurrencyQuery: mocks.concurrencyQuery,
  useOwnerPlanQuery: mocks.ownerPlanQuery,
}))

vi.mock('@/hooks/queries/usePlansQuery', () => ({ usePlansQuery: mocks.plansQuery }))
vi.mock('@/lib/plan-concurrency', () => ({ planConcurrencyLimit: mocks.planConcurrencyLimit }))

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => createElement('div', {}, children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}))

vi.mock('recharts', () => ({
  CartesianGrid: () => null,
  Line: () => null,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) =>
    createElement('div', { 'data-testid': 'line-chart', 'data-points': JSON.stringify(data) }, children),
  ReferenceLine: ({ y }: { y: number }) => createElement('div', { 'data-testid': 'limit-line' }, String(y)),
  XAxis: () => null,
  YAxis: () => null,
}))

import { ConcurrencyTimeline, concurrencyAxisMaximum } from './ConcurrencyTimeline'

describe('concurrencyAxisMaximum', () => {
  it('keeps both the observed peak and the plan limit inside the chart', () => {
    expect(concurrencyAxisMaximum([{ time: 0, runningBoxes: 105 }], 100)).toBe(120)
    expect(concurrencyAxisMaximum([{ time: 0, runningBoxes: 30 }], 100)).toBe(120)
  })

  it('keeps an empty series readable', () => {
    expect(concurrencyAxisMaximum([], null)).toBe(2)
  })
})

describe('ConcurrencyTimeline', () => {
  let root: Root | null = null
  const refetch = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    refetch.mockReset()
    mocks.concurrencyQuery.mockReset().mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: false,
      refetch,
    })
    mocks.ownerPlanQuery.mockReset().mockReturnValue({ data: undefined })
    mocks.plansQuery.mockReset().mockReturnValue({ data: undefined })
    mocks.planConcurrencyLimit.mockReset().mockReturnValue(null)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  function renderTimeline() {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(createElement(ConcurrencyTimeline))
    })
  }

  it('shows the loading state while concurrency is being fetched', () => {
    mocks.concurrencyQuery.mockReturnValue({ isError: false, isLoading: true, refetch })

    renderTimeline()

    expect(document.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="line-chart"]')).toBeNull()
  })

  it('shows a retryable error state', () => {
    mocks.concurrencyQuery.mockReturnValue({ isError: true, isLoading: false, refetch })

    renderTimeline()

    expect(document.body.textContent).toContain('Failed to load concurrency')
    const retryButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Retry')
    expect(retryButton).toBeDefined()

    act(() => retryButton?.click())
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('maps populated API points into the chart series', () => {
    mocks.concurrencyQuery.mockReturnValue({
      data: {
        points: [
          { observedAt: '2026-07-01T00:00:00.000Z', runningBoxes: 3 },
          { observedAt: '2026-07-02T00:00:00.000Z', runningBoxes: 5 },
        ],
      },
      isError: false,
      isLoading: false,
      refetch,
    })

    renderTimeline()

    const chart = document.querySelector<HTMLElement>('[data-testid="line-chart"]')
    expect(JSON.parse(chart?.dataset.points ?? '[]')).toEqual([
      { time: new Date('2026-07-01T00:00:00.000Z').getTime(), runningBoxes: 3 },
      { time: new Date('2026-07-02T00:00:00.000Z').getTime(), runningBoxes: 5 },
    ])
  })

  it('renders the optional plan-limit label and reference line', () => {
    mocks.planConcurrencyLimit.mockReturnValue(100)

    renderTimeline()

    expect(document.body.textContent).toContain('limit = 100')
    expect(document.querySelector('[data-testid="limit-line"]')?.textContent).toBe('100')
  })
})
