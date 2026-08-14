// @vitest-environment jsdom
/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import InfrastructureLogs from './InfrastructureLogs'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  refetch: vi.fn(),
  result: {
    data: { items: [], nextToken: 'cursor-2' },
    isLoading: false,
    isError: false,
  },
}))

vi.mock('@/hooks/useInfrastructureLogs', () => ({
  useInfrastructureLogs: (query: unknown) => {
    mocks.query(query)
    return { ...mocks.result, refetch: mocks.refetch }
  },
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select aria-label="Log source" value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

vi.mock('@/components/telemetry/TimeRangeSelector', () => ({
  TimeRangeSelector: () => null,
}))

vi.mock('@/components/telemetry/LogTable', () => ({
  LogTable: ({ isError, onRetry }: { isError: boolean; onRetry: () => void }) =>
    isError ? <button onClick={onRetry}>Retry logs</button> : <div>Log results</div>,
}))

describe('InfrastructureLogs', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    mocks.query.mockClear()
    mocks.refetch.mockClear()
    mocks.result = {
      data: { items: [], nextToken: 'cursor-2' },
      isLoading: false,
      isError: false,
    }
  })

  function renderPage() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<InfrastructureLogs />))
  }

  it('resets pagination when the log source changes', () => {
    renderPage()

    const nextButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Next'))
    expect(nextButton).toBeDefined()
    act(() => nextButton?.click())
    expect(mocks.query.mock.lastCall?.[0]).toMatchObject({ source: 'runner', nextToken: 'cursor-2' })

    const source = document.querySelector<HTMLSelectElement>('select[aria-label="Log source"]')
    expect(source).not.toBeNull()
    act(() => {
      if (!source) return
      source.value = 'collector'
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.query.mock.lastCall?.[0]).toMatchObject({ source: 'collector', nextToken: undefined })
  })

  it('retries the current query from the error state', () => {
    mocks.result = { data: { items: [], nextToken: undefined }, isLoading: false, isError: true }
    renderPage()

    const retryButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry logs')
    expect(retryButton).toBeDefined()
    act(() => retryButton?.click())

    expect(mocks.refetch).toHaveBeenCalledOnce()
  })
})
