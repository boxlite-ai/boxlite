// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Box, BoxDesiredState, BoxProgressPhase, BoxState } from '@boxlite-ai/api-client'
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

  it.each([
    ['Start', BoxState.STOPPED, 'handleStart'],
    ['Stop', BoxState.STARTED, 'handleStop'],
    ['Recover', BoxState.ERROR, 'handleRecover'],
  ] as const)('dispatches %s for the selected box without opening its row', (label, state, handler) => {
    const box = { ...makeBox('action-target'), state, recoverable: true }
    const props = renderBoxTable({ data: [box] })
    const actions = document.querySelectorAll<HTMLButtonElement>(`button[title="${label}"]`)
    expect(actions).toHaveLength(2)

    actions.forEach((button) => act(() => button.click()))

    expect(props[handler]).toHaveBeenCalledTimes(2)
    expect(props[handler]).toHaveBeenCalledWith(box.id)
    expect(props.onRowClick).not.toHaveBeenCalled()
  })

  it('provides a native detail link without dispatching row navigation twice', () => {
    const onRowClick = vi.fn()
    renderBoxTable({ onRowClick, data: [makeBox('1')] })
    const link = document.querySelector<HTMLAnchorElement>('a[href="/dashboard/boxes/1"]')
    expect(link).not.toBeNull()
    act(() => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])('preserves native detail navigation for %s', (modifier) => {
    const props = renderBoxTable({ data: [makeBox('native')] })
    const link = document.querySelector<HTMLAnchorElement>('a[href="/dashboard/boxes/native"]')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true })
    act(() => link.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(props.onRowClick).not.toHaveBeenCalled()
  })

  it('keeps detail links native when no row callback is provided', () => {
    renderBoxTable({ data: [makeBox('native')], onRowClick: undefined })
    const link = document.querySelector<HTMLAnchorElement>('a[href="/dashboard/boxes/native"]')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })

  it.each(['Enter', ' '])('keeps %s on a nested copy button out of card navigation', (key) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = renderBoxTable({ data: [makeBox('keyboard')] })
    const card = document.querySelector<HTMLElement>('div[role="button"]')!
    const copy = card.querySelector<HTMLButtonElement>('button[title="Copy name"]')!
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => {
      copy.focus()
      copy.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(props.onRowClick).not.toHaveBeenCalled()
    // jsdom does not synthesize a native button click from keyboard events.
    act(() => copy.click())
    expect(writeText).toHaveBeenCalledWith('box-keyboard')
    expect(props.onRowClick).not.toHaveBeenCalled()
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
    expect(props.onRowClick).toHaveBeenCalledTimes(1)
  })

  it('keeps a transitioning box action disabled', () => {
    const props = renderBoxTable({ data: [{ ...makeBox('busy'), state: BoxState.STARTING }] })
    const actions = document.querySelectorAll<HTMLButtonElement>('button[title="Working…"]')
    expect(actions).toHaveLength(2)

    actions.forEach((button) => {
      expect(button.disabled).toBe(true)
      act(() => button.click())
    })

    expect(props.handleStart).not.toHaveBeenCalled()
    expect(props.handleStop).not.toHaveBeenCalled()
    expect(props.handleRecover).not.toHaveBeenCalled()
  })

  it('opens checkpoint capture for the selected Box from More without opening its row', async () => {
    const box = { ...makeBox('capture-source'), desiredState: BoxDesiredState.STOPPED }
    const onCreateCheckpoint = vi.fn()
    const props = renderBoxTable({ data: [box], onCreateCheckpoint })
    await act(async () => {
      document
        .querySelector('[aria-label="More"]')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const action = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'Checkpoint',
    )
    expect(action).toBeDefined()
    await act(async () => action!.click())
    expect(onCreateCheckpoint).toHaveBeenCalledWith(box)
    expect(props.onRowClick).not.toHaveBeenCalled()
  })

  it('does not offer checkpoint capture for a source changing state', async () => {
    const box = { ...makeBox('busy-source'), desiredState: BoxDesiredState.STARTED }
    renderBoxTable({ data: [box], onCreateCheckpoint: vi.fn() })
    await act(async () => {
      document
        .querySelector('[aria-label="More"]')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).some(
        (item) => item.textContent?.trim() === 'Checkpoint',
      ),
    ).toBe(false)
  })

  it('does not navigate when the click ends a text selection over a row', () => {
    const onRowClick = vi.fn()
    renderBoxTable({ onRowClick, data: [makeBox('1')] })

    // Desktop row and mobile card both carry the row-navigation click handler.
    const clickTargets = Array.from(document.querySelectorAll<HTMLElement>('div.cursor-pointer'))
    expect(clickTargets.length).toBeGreaterThan(0)

    const nameEl = Array.from(document.querySelectorAll('span')).find((el) => el.textContent === 'box-1')
    if (!nameEl) throw new Error('Missing box name element')

    // Simulate the tail end of a drag-to-copy: text is selected when the
    // mouseup fires the row's click.
    const selection = window.getSelection()
    if (!selection) throw new Error('Missing selection API')
    const range = document.createRange()
    range.selectNodeContents(nameEl)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.isCollapsed).toBe(false)

    for (const target of clickTargets) {
      act(() => {
        target.click()
      })
    }
    expect(onRowClick).not.toHaveBeenCalled()

    // A plain click (no selection) still navigates.
    selection.removeAllRanges()
    act(() => {
      clickTargets[0].click()
    })
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }))
  })

  it('copies the box name without navigating when the copy button is clicked', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const onRowClick = vi.fn()
    renderBoxTable({ onRowClick, data: [makeBox('1')] })

    const copyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[title="Copy name"]'))
    // Desktop row and mobile card each render one.
    expect(copyButtons.length).toBe(2)

    act(() => {
      copyButtons[0].click()
    })

    expect(writeText).toHaveBeenCalledWith('box-1')
    expect(onRowClick).not.toHaveBeenCalled()
  })

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

describe('BoxTable first pull', () => {
  let root: Root | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function renderRow(box: Box) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(<BoxTable {...baseProps} data={[box]} />)
    })
  }

  // A first pull is the one slow step the API reports; a box that sits in
  // creating for a minute should say why rather than look stuck.
  it('says a box is pulling its image while the API reports a first pull', () => {
    renderRow({
      ...makeBox('1'),
      state: BoxState.CREATING,
      progress: { phase: BoxProgressPhase.PREPARING_IMAGE, retryAfterMs: 5000 },
    })

    expect(document.body.textContent).toContain('Pulling image')
  })

  it('says a creating box is starting when no pull is reported', () => {
    renderRow({ ...makeBox('1'), state: BoxState.CREATING })

    expect(document.body.textContent).toContain('Starting')
    expect(document.body.textContent).not.toContain('Pulling image')
  })
})

describe('BoxTable empty state', () => {
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

  function renderEmpty(overrides: Partial<BoxTableProps> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props: BoxTableProps = { ...baseProps, data: [], totalItems: 0, pageCount: 0, ...overrides }

    act(() => {
      root = createRoot(host)
      root.render(<BoxTable {...props} />)
    })

    return props
  }

  function quickstartButtons() {
    return Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.startsWith('Open Quickstart'),
    )
  }

  it('offers the quickstart from the empty state when there is a guide to open', () => {
    const onOpenQuickstart = vi.fn()
    renderEmpty({ onOpenQuickstart })

    // Desktop table and mobile card list each render the empty state.
    const buttons = quickstartButtons()
    expect(buttons.length).toBeGreaterThan(0)

    buttons.forEach((button) => act(() => button.click()))
    expect(onOpenQuickstart).toHaveBeenCalledTimes(buttons.length)
  })

  it('offers filter recovery in the compact empty list', () => {
    const onFiltersChange = vi.fn()
    renderEmpty({ filters: { idOrName: 'missing' }, onFiltersChange })
    const mobile = document.querySelector('[role="region"][aria-label="Box cards"]')!
    expect(mobile.textContent).toContain('No matching Boxes')
    const clear = [...mobile.querySelectorAll('button')].find((button) => button.textContent === 'Clear filter')!
    act(() => clear.click())
    expect(onFiltersChange).toHaveBeenCalledWith({ idOrName: undefined })
    expect(mobile.textContent).not.toContain('Open Quickstart')
  })

  it('distinguishes an empty search and offers to clear its filter', () => {
    const onFiltersChange = vi.fn()
    renderEmpty({ filters: { idOrName: 'missing' }, onFiltersChange })
    expect(document.body.textContent).toContain('No matching Boxes')
    expect(quickstartButtons()).toHaveLength(0)
    const clear = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Clear filter')!
    act(() => clear.click())
    expect(onFiltersChange).toHaveBeenCalledWith({ idOrName: undefined })
  })

  it('still explains itself when no guide is available to open', () => {
    renderEmpty()

    expect(quickstartButtons()).toHaveLength(0)
    expect(document.body.textContent).toContain('Your agent creates them through the SDK')
  })
})
