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
import BoxDetails from './BoxDetails'

const mocks = vi.hoisted(() => ({
  box: undefined as Box | undefined,
  loading: false,
  error: false,
  writable: true,
  pending: false,
  start: vi.fn(),
  terminalMounts: vi.fn(),
  terminalUnmounts: vi.fn(),
  refetch: vi.fn(),
  images: vi.fn(),
  volumes: vi.fn(),
  organizationId: 'org-1',
}))
vi.mock('@/hooks/queries/useBoxQuery', () => ({
  useBoxQuery: () => ({
    data: mocks.box,
    isLoading: mocks.loading,
    isError: mocks.error,
    error: mocks.error ? new Error('Unavailable') : null,
    refetch: mocks.refetch,
  }),
}))
vi.mock('@/hooks/useBoxWsSync', () => ({ useBoxWsSync: () => {} }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: mocks.organizationId },
    authenticatedUserOrganizationMember: { role: 'OWNER' },
    authenticatedUserHasPermission: () => mocks.writable,
  }),
}))
vi.mock('@/hooks/mutations/useStartBoxMutation', () => ({
  useStartBoxMutation: () => ({ isPending: mocks.pending, mutateAsync: mocks.start }),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'user-1' } } }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({}) }))
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ getRegionName: (target: string) => target }) }))
vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImagesQuery: () => {
    mocks.images()
    return { data: [] }
  },
}))
vi.mock('@/hooks/queries/useVolumesQuery', () => ({
  useVolumesQuery: () => {
    mocks.volumes()
    return { data: [] }
  },
}))
vi.mock('@/hooks/mutations/useStopBoxMutation', () => ({
  useStopBoxMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/mutations/useRecoverBoxMutation', () => ({
  useRecoverBoxMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/mutations/useDeleteBoxMutation', () => ({
  useDeleteBoxMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))
vi.mock('./BoxNetworkSection', () => ({ BoxNetworkSection: () => null }))
vi.mock('./BoxSshTab', async () => {
  const { useState } = await import('react')
  return {
    BoxSshTab: () => {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(!open)}>Connect via SSH</button>
          {open && <div>SSH controls</div>}
        </>
      )
    },
  }
})
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

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name,
  )
  if (!button) throw new Error(`Missing button: ${name}`)
  return button
}

const navigateTo = async (text: string) => {
  const link = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Box pages"] a')].find(
    (anchor) => anchor.textContent === text,
  )
  if (!link) throw new Error(`Missing page link: ${text}`)
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })))
}

describe('BoxTerminal page', () => {
  let root: Root

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.box = {
      id: 'box-1',
      name: 'web-api',
      state: BoxState.STARTED,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as Box
    mocks.organizationId = 'org-1'
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
  async function renderPage(page: 'overview' | 'terminal' = 'terminal') {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/dashboard/boxes/box-1${page === 'terminal' ? '/terminal' : ''}`]}>
          <Routes>
            <Route path="/dashboard/boxes/:boxId/terminal" element={<BoxDetails page="terminal" />} />
            <Route path="/dashboard/boxes/:boxId" element={<BoxDetails />} />
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
    expect(document.querySelector('[aria-label="Box configuration"]')).not.toBeNull()
    expect(mocks.terminalUnmounts).toHaveBeenCalledWith('box-1')
  })

  it('keeps the Box identity, status and management actions on Terminal', async () => {
    await renderPage()
    expect(document.querySelector('h1')?.textContent).toBe('web-api')
    expect(document.body.textContent).toContain('Running')
    const buttons = [...document.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(buttons).toContain('Connect via SSH')
    expect(buttons).toContain('Stop')
  })

  it('preserves the same header and SSH state across both routes while unmounting the shell', async () => {
    await renderPage('overview')
    const heading = document.querySelector('h1')
    const navigation = document.querySelector('nav[aria-label="Box pages"]')
    await act(async () => buttonNamed('Connect via SSH').click())
    expect(mocks.terminalMounts).not.toHaveBeenCalled()
    const overviewQueries = mocks.images.mock.calls.length
    await navigateTo('Terminal')
    expect(document.querySelector('h1')).toBe(heading)
    expect(document.querySelector('nav[aria-label="Box pages"]')).toBe(navigation)
    expect(document.body.textContent).toContain('SSH controls')
    expect(mocks.terminalMounts).toHaveBeenCalledTimes(1)
    expect(mocks.images).toHaveBeenCalledTimes(overviewQueries)
    await navigateTo('Overview')
    expect(document.querySelector('h1')).toBe(heading)
    expect(document.body.textContent).toContain('SSH controls')
    expect(mocks.terminalUnmounts).toHaveBeenCalledTimes(1)
    await navigateTo('Terminal')
    await act(async () => buttonNamed('Refresh').click())
    expect(mocks.refetch).toHaveBeenCalledOnce()
    expect(mocks.terminalMounts).toHaveBeenCalledTimes(2)
  })

  it('shows provisioned capacity only in Overview across page changes', async () => {
    mocks.box = { ...mocks.box, cpu: 2, memory: 4, disk: 20 } as Box
    await renderPage('overview')
    const values = [...document.querySelectorAll('[aria-label="Box resources"] dl > div')]
    expect(
      values.map((field) => [field.querySelector('dt')?.textContent, field.querySelector('dd')?.textContent]),
    ).toEqual([
      ['CPU', '2vCPU'],
      ['Memory', '4GiB'],
      ['Disk', '20GiB'],
    ])
    await navigateTo('Terminal')
    expect(document.querySelector('[aria-label="Box resources"]')).toBeNull()
    await navigateTo('Overview')
    expect(document.querySelector('[aria-label="Box resources"]')?.textContent).toContain('2vCPU')
  })

  it('does not fetch Overview catalogs when Terminal opens directly', async () => {
    await renderPage()
    expect(mocks.images).not.toHaveBeenCalled()
    expect(mocks.volumes).not.toHaveBeenCalled()
  })

  it('resets Box-scoped controls when the organization changes', async () => {
    await renderPage()
    const ssh = buttonNamed('Connect via SSH')
    await act(async () => ssh.click())
    expect(document.body.textContent).toContain('SSH controls')
    mocks.organizationId = 'org-2'
    await renderPage()
    expect(document.body.textContent).not.toContain('SSH controls')
    expect(mocks.terminalUnmounts).toHaveBeenCalledTimes(1)
  })

  it('starts a stopped box through the existing mutation', async () => {
    mocks.box = { ...mocks.box, state: BoxState.STOPPED } as Box
    await renderPage()
    const start = buttonNamed('Start')
    await act(async () => start.click())
    expect(mocks.start).toHaveBeenCalledWith({ boxId: 'box-1', detailRef: 'box-1' })
    expect(mocks.terminalMounts).not.toHaveBeenCalled()
  })

  it('blocks overlapping start requests while the mutation is pending', async () => {
    mocks.box = { ...mocks.box, state: BoxState.STOPPED } as Box
    mocks.pending = true
    await renderPage()
    const start = buttonNamed('Start')
    expect(start.disabled).toBe(true)
    await act(async () => start.click())
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'starting', 'loading', 'missing'] as const)(
    'does not start a shell or offer Start for %s',
    async (state) => {
      mocks.box = { ...mocks.box, state: state === 'starting' ? BoxState.STARTING : BoxState.STOPPED } as Box
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
      expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Start')).toBe(
        false,
      )
      if (state === 'loading' || state === 'missing') {
        expect(document.querySelector('nav[aria-label="Box pages"]')).toBeNull()
      } else {
        expect(document.querySelector('a[aria-current="page"]')?.textContent).toBe('Terminal')
      }
    },
  )
})
