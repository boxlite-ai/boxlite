// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Box, BoxState } from '@boxlite-ai/api-client'
import BoxTerminalFullscreen from './BoxTerminalFullscreen'

const mocks = vi.hoisted(() => ({
  box: undefined as Box | undefined,
  loading: false,
  error: false,
  writable: true,
  pending: false,
  start: vi.fn(),
  terminalMounts: vi.fn(),
  terminalUnmounts: vi.fn(),
}))
vi.mock('@/hooks/queries/useBoxQuery', () => ({
  useBoxQuery: () => ({ data: mocks.box, isLoading: mocks.loading, isError: mocks.error }),
}))
vi.mock('@/hooks/useBoxWsSync', () => ({ useBoxWsSync: () => {} }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ authenticatedUserHasPermission: () => mocks.writable }),
}))
vi.mock('@/hooks/mutations/useStartBoxMutation', () => ({
  useStartBoxMutation: () => ({ isPending: mocks.pending, mutateAsync: mocks.start }),
}))
vi.mock('./BoxTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    BoxTerminal: ({ boxId }: { boxId: string }) => {
      useEffect(() => {
        mocks.terminalMounts(boxId)
        return () => {
          mocks.terminalUnmounts(boxId)
        }
      }, [boxId])
      return <div data-testid="terminal">Shell</div>
    },
  }
})

describe('BoxTerminal page', () => {
  let root: Root

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.box = { id: 'box-1', name: 'web-api', state: BoxState.STARTED } as Box
    mocks.loading = false
    mocks.error = false
    mocks.writable = true
    mocks.pending = false
    mocks.start.mockResolvedValue(undefined)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
  })
  async function renderPage() {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes/box-1/terminal']}>
          <Routes>
            <Route path="/dashboard/boxes/:boxId/terminal" element={<BoxTerminalFullscreen />} />
            <Route path="/dashboard/boxes/:boxId" element={<div>Overview destination</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    )
  }

  it('mounts the shell only on Terminal and leaves it when Overview is selected', async () => {
    await renderPage()
    expect(mocks.terminalMounts).toHaveBeenCalledWith('box-1')
    const links = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Box pages"] a')]
    expect(links.map((link) => [link.textContent, link.getAttribute('aria-current')])).toEqual([
      ['Overview', null],
      ['Terminal', 'page'],
    ])
    await act(async () =>
      links[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
    )
    expect(document.body.textContent).toContain('Overview destination')
    expect(mocks.terminalUnmounts).toHaveBeenCalledWith('box-1')
  })

  it('starts a stopped box through the existing mutation', async () => {
    mocks.box!.state = BoxState.STOPPED
    await renderPage()
    const start = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Start box'))!
    await act(async () => start.click())
    expect(mocks.start).toHaveBeenCalledWith({ boxId: 'box-1', detailRef: 'box-1' })
    expect(mocks.terminalMounts).not.toHaveBeenCalled()
  })

  it('blocks overlapping start requests while the mutation is pending', async () => {
    mocks.box!.state = BoxState.STOPPED
    mocks.pending = true
    await renderPage()
    const start = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Start box'))!
    expect(start.disabled).toBe(true)
    await act(async () => start.click())
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'starting', 'loading', 'missing'] as const)(
    'does not start a shell or offer Start for %s',
    async (state) => {
      mocks.box!.state = state === 'starting' ? BoxState.STARTING : BoxState.STOPPED
      if (state === 'read-only') mocks.writable = false
      if (state === 'loading') {
        mocks.loading = true
        mocks.box = undefined
      }
      if (state === 'missing') {
        mocks.error = true
        mocks.box = undefined
      }
      await renderPage()
      expect(mocks.terminalMounts).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('Start box')
      expect(document.querySelector('a[aria-current="page"]')?.textContent).toBe('Terminal')
    },
  )
})
