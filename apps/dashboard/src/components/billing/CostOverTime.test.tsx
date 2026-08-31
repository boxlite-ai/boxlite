// @vitest-environment jsdom

/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  usageSeriesQuery: vi.fn(),
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerUsageSeriesQuery: mocks.usageSeriesQuery,
}))

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => createElement('div', {}, children),
  ChartTooltip: ({ payloadUniqBy }: { payloadUniqBy?: boolean }) =>
    createElement('g', { 'data-testid': 'tooltip', 'data-payload-uniq-by': payloadUniqBy }),
  ChartTooltipContent: () => null,
}))

vi.mock('recharts', () => ({
  Area: ({
    activeDot,
    dataKey,
    fill,
    stackId,
    stroke,
    tooltipType,
  }: {
    activeDot?: boolean | Record<string, string>
    dataKey: string
    fill?: string
    stackId?: string
    stroke?: string
    tooltipType?: string
  }) =>
    createElement('g', {
      'data-testid': 'area',
      'data-active-dot': activeDot === undefined ? 'default' : JSON.stringify(activeDot),
      'data-fill': fill,
      'data-key': dataKey,
      'data-stack-id': stackId,
      'data-stroke': stroke,
      'data-tooltip-type': tooltipType,
    }),
  AreaChart: ({ data, children }: { data: unknown; children: ReactNode }) =>
    createElement('svg', { 'data-testid': 'area-chart', 'data-points': JSON.stringify(data) }, children),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

import { CostOverTime } from './CostOverTime'

describe('CostOverTime', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.usageSeriesQuery.mockReset().mockImplementation((granularity: 'day' | 'hour') => ({
      data:
        granularity === 'day'
          ? [
              {
                from: new Date('2026-08-29T00:00:00.000Z'),
                to: new Date('2026-08-30T00:00:00.000Z'),
                quotaCoveredCents: 526,
                fromWalletCents: 36,
              },
            ]
          : undefined,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    }))
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('keeps the total stacked while plotting the wallet marker from its raw value', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(createElement(CostOverTime))
    })

    const chart = document.querySelector<HTMLElement>('[data-testid="area-chart"]')
    expect(JSON.parse(chart?.dataset.points ?? '[]')).toEqual([
      {
        time: '2026-08-29T00:00:00.000Z',
        quota: 5.26,
        wallet: 0.36,
        total: 5.62,
      },
    ])

    const areas = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="area"]')).map((area) => ({
      activeDot: area.dataset.activeDot,
      dataKey: area.dataset.key,
      fill: area.dataset.fill,
      stackId: area.getAttribute('data-stack-id'),
      stroke: area.dataset.stroke,
      tooltipType: area.getAttribute('data-tooltip-type'),
    }))
    expect(areas).toEqual([
      {
        activeDot: 'default',
        dataKey: 'quota',
        fill: 'url(#cost-quota)',
        stackId: 'a',
        stroke: 'var(--color-quota)',
        tooltipType: null,
      },
      {
        activeDot: 'false',
        dataKey: 'wallet',
        fill: 'url(#cost-wallet)',
        stackId: 'a',
        stroke: 'var(--color-wallet)',
        tooltipType: null,
      },
      {
        activeDot: '{"fill":"var(--color-wallet)"}',
        dataKey: 'wallet',
        fill: 'transparent',
        stackId: null,
        stroke: 'transparent',
        tooltipType: 'none',
      },
    ])

    expect(document.querySelector<HTMLElement>('[data-testid="tooltip"]')?.dataset.payloadUniqBy).toBe('true')
  })
})
