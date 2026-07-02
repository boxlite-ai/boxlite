// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Box, BoxState } from '@boxlite-ai/api-client'
import { BoxTable } from './index'
import { type BoxTableProps } from './types'

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    authenticatedUserHasPermission: () => true,
  }),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: ReactNode
  }) => (
    <select
      aria-label="Rows per page"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

function makeBox(id: string): Box {
  return {
    id,
    name: `box-${id}`,
    state: BoxState.STOPPED,
    cpu: 1,
    memory: 2,
    disk: 10,
    createdAt: '2026-06-01T00:00:00.000Z',
  } as Box
}

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)

  if (!element) {
    throw new Error(`Missing expected element: ${selector}`)
  }

  return element
}

const baseProps: BoxTableProps = {
  data: Array.from({ length: 25 }, (_, index) => makeBox(`${index + 1}`)),
  boxIsLoading: {},
  boxStateIsTransitioning: {},
  loading: false,
  handleStart: vi.fn(),
  handleStop: vi.fn(),
  handleDelete: vi.fn(),
  handleBulkDelete: vi.fn(),
  handleBulkStart: vi.fn(),
  handleBulkStop: vi.fn(),
  onRowClick: vi.fn(),
  pagination: {
    pageIndex: 1,
    pageSize: 25,
  },
  pageCount: 4,
  totalItems: 92,
  onPaginationChange: vi.fn(),
  sorting: {},
  onSortingChange: vi.fn(),
  filters: {},
  onFiltersChange: vi.fn(),
  handleRecover: vi.fn(),
}

describe('BoxTable pagination controls', () => {
  let root: Root | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  function renderBoxTable(overrides: Partial<BoxTableProps> & { isPageFetching?: boolean } = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props = {
      ...baseProps,
      ...overrides,
    }

    act(() => {
      root = createRoot(host)
      root.render(<BoxTable {...props} />)
    })

    return props
  }

  it('lets the user choose how many boxes are shown per page', () => {
    const onPaginationChange = vi.fn()
    renderBoxTable({ onPaginationChange })

    const pageSizeSelect = getRequiredElement<HTMLSelectElement>('select[aria-label="Rows per page"]')

    expect(pageSizeSelect.value).toBe('25')

    act(() => {
      pageSizeSelect.value = '50'
      pageSizeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onPaginationChange).toHaveBeenCalledWith({ pageIndex: 0, pageSize: 50 })
  })

  it('prevents stacked page requests while a page change is loading', () => {
    const onPaginationChange = vi.fn()
    renderBoxTable({
      isPageFetching: true,
      onPaginationChange,
    })

    expect(document.body.textContent).toContain('Loading boxes...')
    expect(document.body.textContent).not.toContain('Showing 26-50 of 92 boxes')
    expect(document.body.textContent).toContain('Loading page')

    const nextButton = getRequiredElement<HTMLButtonElement>('button[title="Next"]')
    expect(nextButton.disabled).toBe(true)

    act(() => {
      nextButton.click()
    })

    expect(onPaginationChange).not.toHaveBeenCalled()
  })

  it('allows pagination controls when the current page is not being replaced', () => {
    const onPaginationChange = vi.fn()
    renderBoxTable({ onPaginationChange })

    const nextButton = getRequiredElement<HTMLButtonElement>('button[title="Next"]')
    expect(nextButton.disabled).toBe(false)

    act(() => {
      nextButton.click()
    })

    expect(onPaginationChange).toHaveBeenCalledWith({ pageIndex: 2, pageSize: 25 })
  })
})
