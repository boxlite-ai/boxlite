// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CiPage from './CiPage'

const mocks = vi.hoisted(() => ({
  events: new Map<string, () => void>(),
  socket: { connected: true, on: vi.fn(), off: vi.fn() },
  api: {
    getCiRunners: vi.fn(),
    getCiSettings: vi.fn(),
    getCiConnectConfiguration: vi.fn(),
    deleteCiConnection: vi.fn(),
    updateCiConnection: vi.fn(),
    setCiCapacity: vi.fn(),
  },
  selection: {
    selectedOrganization: { id: 'account-a' },
    authenticatedUserOrganizationMember: { role: 'owner' },
    authenticatedUserHasPermission: vi.fn(() => true),
  },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selection }))
vi.mock('@/hooks/useNotificationSocket', () => ({
  useNotificationSocket: () => ({ notificationSocket: mocks.socket }),
}))
function Location() {
  const location = useLocation()
  return <output>{location.pathname}</output>
}
describe('CI page', () => {
  let root: Root | undefined, cache: QueryClient
  const capacity = { available: true, used: 2, effective_limit: 5, max_concurrent_jobs: null, commerce_limit: 5 }
  const runner = {
    id: 'runner-original',
    name: 'ci-jit-original',
    state: 'started',
    image: 'runner:test',
    cpu: 2,
    memory: 2,
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    mocks.events.clear()
    mocks.api.setCiCapacity.mockResolvedValue({ ...capacity, connections: [] })
    mocks.socket.connected = true
    mocks.socket.on.mockImplementation((event, handler) => mocks.events.set(event, handler))
    mocks.socket.off.mockImplementation((event) => mocks.events.delete(event))
    mocks.selection.selectedOrganization.id = 'account-a'
    mocks.selection.authenticatedUserOrganizationMember.role = 'owner'
    mocks.selection.authenticatedUserHasPermission.mockReturnValue(true)
    mocks.api.getCiRunners.mockResolvedValue({ items: [runner], total: 1, page: 1, totalPages: 1, capacity })
    mocks.api.getCiSettings.mockImplementation(async (organization) => ({
      available: true,
      effective_limit: 5,
      commerce_limit: 5,
      max_concurrent_jobs: null,
      connections: [
        {
          binding_id: 'binding',
          github_account: organization === 'account-a' ? 'alice' : 'bob',
          account_type: 'User',
          listener_status: 'ready',
          allow_private_repositories: false,
        },
      ],
    }))
    mocks.api.getCiConnectConfiguration.mockResolvedValue({
      apps: [{ account_type: 'User', web_connect_available: true }],
    })
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    cache.clear()
    document.body.innerHTML = ''
  })
  async function render(path = '/dashboard/ci') {
    if (!root) {
      const node = document.createElement('div')
      document.body.append(node)
      root = createRoot(node)
    }
    await act(async () =>
      root!.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/dashboard/ci" element={<CiPage tab="runners" />} />
              <Route path="/dashboard/ci/connects" element={<CiPage tab="connects" />} />
            </Routes>
            <Location />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  it('associates the selected CI tab with its rendered panel', async () => {
    await render()
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')!
    const panel = document.getElementById(tab.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('role')).toBe('tabpanel')
    expect(panel?.textContent).toContain(runner.name)
  })
  it('keeps Previous available when a later runner page fails', async () => {
    mocks.api.getCiRunners.mockImplementation(async (_organization, page) => {
      if (page === 2) throw Error('unavailable')
      return { items: [runner], total: 26, page: 1, totalPages: 2, capacity }
    })
    await render()
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent === 'Next')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const previous = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Previous')
    expect(previous).toBeDefined()
    expect(previous!.disabled).toBe(false)
    await act(async () => previous!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('tbody')?.textContent).toContain(runner.name)
  })
  it('shows JIT Boxes and navigates between independently addressable table views', async () => {
    await render()
    expect(document.querySelector('h1')?.textContent).toBe('Runners')
    expect(document.querySelector('tbody a')?.getAttribute('href')).toBe('/dashboard/boxes/runner-original')
    expect(document.querySelector('tbody')?.textContent).toContain('JIT')
    expect(document.querySelector('tbody td svg')?.getAttribute('width')).toBe('28')
    expect(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('2')
    expect(document.body.textContent).toContain('2 of 5 slots')
    expect(mocks.api.getCiRunners).toHaveBeenCalledWith('account-a', 1, 25)
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Refresh')).toBe(false)
    const tab = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent === 'Connects')!
    await act(async () => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('output')?.textContent).toBe('/dashboard/ci/connects')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Refresh')).toBe(false)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Connects')
  })
  it('lets organization members inspect runners without connection-management actions', async () => {
    mocks.selection.authenticatedUserOrganizationMember.role = 'member'
    await render()
    expect(mocks.api.getCiRunners).toHaveBeenCalledWith('account-a', 1, 25)
    expect(document.querySelector('tbody')?.textContent).toContain('ci-jit-original')
    expect(document.body.textContent).not.toContain('Connect GitHub')
    expect(document.body.textContent).not.toContain('Edit')
    expect(document.body.textContent).toContain('2 of 5 slots')
    expect(mocks.api.getCiSettings).not.toHaveBeenCalled()
  })
  it('automatically retries a failed inventory request without a refresh control', async () => {
    mocks.api.getCiRunners
      .mockRejectedValueOnce(Error('unavailable'))
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0, capacity })
    await render()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Runners could not be loaded')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100))
    })
    expect(document.body.textContent).toContain('No CI runners')
    expect(mocks.api.getCiRunners).toHaveBeenCalledTimes(2)
  }, 10000)
  it('refetches on Box events and removes subscriptions when leaving Runners', async () => {
    await render()
    mocks.api.getCiRunners.mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0, capacity })
    await act(async () => mocks.events.get('box.state.updated')!())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.body.textContent).toContain('No CI runners')
    expect(mocks.api.getCiRunners).toHaveBeenCalledTimes(2)
    const tab = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent === 'Connects')!
    await act(async () => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(mocks.events.size).toBe(0)
  })
  it.each([
    [0, 2, '2 in use · Paused'],
    [null, 2, '2 in use · Unlimited'],
    [1, 2, '2 of 1 slots'],
  ])('renders capacity limit %s without an invalid meter range', async (limit, used, label) => {
    mocks.api.getCiRunners.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      totalPages: 0,
      capacity: { ...capacity, used, effective_limit: limit },
    })
    await render()
    expect(document.body.textContent).toContain(label)
    const meter = document.querySelector('[role="meter"]')
    if (limit === null || limit === 0) expect(meter).toBeNull()
    else {
      expect(meter?.getAttribute('aria-valuenow')).toBe('1')
      expect(meter?.getAttribute('aria-valuetext')).toContain('2 of 1')
    }
  })
  it('edits zero and inherited capacity from Runners and refreshes its original organization', async () => {
    await render()
    for (const value of ['0', '']) {
      await act(async () =>
        [...document.querySelectorAll('button')].find((item) => item.textContent === 'Edit')!.click(),
      )
      const input = document.querySelector<HTMLInputElement>('#ci-maximum')!
      expect(input.max).toBe('5')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () =>
        input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      )
      expect(mocks.api.setCiCapacity).toHaveBeenLastCalledWith('account-a', value === '' ? null : 0)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    }
    expect(mocks.api.getCiRunners.mock.calls.length).toBe(3)
  })
  it('keeps failed capacity edits actionable and prevents excess values', async () => {
    mocks.api.setCiCapacity.mockRejectedValueOnce(Error('unavailable'))
    await render()
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent === 'Edit')!.click())
    const input = document.querySelector<HTMLInputElement>('#ci-maximum')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '6')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(mocks.api.setCiCapacity).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'within your account allowance',
    )
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'Unable to save CI capacity',
    )
  })
  it('refreshes journal-only releases even when no Boxes or socket events exist', async () => {
    mocks.api.getCiRunners
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, totalPages: 0, capacity: { ...capacity, used: 1 } })
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0, capacity: { ...capacity, used: 0 } })
    await render()
    expect(document.body.textContent).toContain('1 of 5 slots')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10100))
    })
    expect(document.body.textContent).toContain('0 of 5 slots')
    expect(mocks.api.getCiRunners).toHaveBeenCalledTimes(2)
  }, 15000)
  it('submits capacity once and keeps a pending save scoped to its original organization', async () => {
    cache.setQueryDefaults(['ci-settings'], { gcTime: Infinity })
    let finish!: (result: unknown) => void
    mocks.api.setCiCapacity.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mocks.api.getCiRunners.mockImplementation(async (organization) => ({
      items: [],
      total: 0,
      page: 1,
      totalPages: 0,
      capacity: { ...capacity, used: organization === 'account-a' ? 2 : 4 },
    }))
    await render()
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent === 'Edit')!.click())
    const form = document.querySelector('#ci-maximum')!.closest('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.api.setCiCapacity).toHaveBeenCalledExactlyOnceWith('account-a', null)
    mocks.selection.selectedOrganization.id = 'account-b'
    await render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => finish({ ...capacity, effective_limit: 3, max_concurrent_jobs: 3, connections: [] }))
    expect(document.body.textContent).toContain('4 of 5 slots')
    expect(cache.getQueryData(['ci-settings', 'account-a'])).toMatchObject({ max_concurrent_jobs: 3 })
    expect(cache.getQueryData(['ci-settings', 'account-b'])).toBeUndefined()
  })
  it('filters names from a later page, preserves capacity while loading and restores results when cleared', async () => {
    let finish!: (result: unknown) => void
    mocks.api.getCiRunners.mockImplementation(async (_org, page, _limit, name) =>
      name
        ? new Promise((resolve) => {
            finish = resolve
          })
        : { items: [{ ...runner, name: 'page-' + page }], total: 26, page, totalPages: 2, capacity },
    )
    await render()
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent === 'Next')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.body.textContent).toContain('Page 2 of 2')
    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter runners by name"]')!
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
    await type(' Runner ')
    expect(input.value).toBe(' Runner ')
    expect(mocks.api.getCiRunners).toHaveBeenLastCalledWith('account-a', 1, 25, 'Runner')
    expect(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('2')
    expect(document.body.textContent).not.toContain('No runners match')
    await act(async () => finish({ items: [], total: 0, page: 1, totalPages: 0, capacity }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.body.textContent).toContain('No runners match “Runner”')
    expect(document.body.textContent).toContain('2 of 5 slots')
    await type('')
    expect(document.querySelector('tbody')?.textContent).toContain('page-1')
    expect(document.body.textContent).not.toContain('No runners match')
    expect(input.value).toBe('')
  })
  it('requests the next bounded page', async () => {
    mocks.api.getCiRunners.mockImplementation(async (_org, page) => ({
      items: [{ ...runner, name: 'runner-page-' + page }],
      total: 26,
      page,
      totalPages: 2,
    }))
    await render()
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent === 'Next')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(mocks.api.getCiRunners).toHaveBeenLastCalledWith('account-a', 2, 25)
    expect(document.querySelector('tbody')?.textContent).toContain('runner-page-2')
  })
  it('keeps a pending connection policy update scoped to its original organization', async () => {
    let finish!: () => void
    mocks.api.updateCiConnection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await render('/dashboard/ci/connects')
    await act(async () =>
      [...document.querySelectorAll('button')].find((item) => item.textContent === 'Update')!.click(),
    )
    await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click())
    await act(async () =>
      [...document.querySelectorAll('button')].find((item) => item.textContent === 'Update connection')!.click(),
    )
    expect(mocks.api.updateCiConnection).toHaveBeenCalledExactlyOnceWith('account-a', 'binding', true)
    mocks.selection.selectedOrganization.id = 'account-b'
    await render('/dashboard/ci/connects')
    await act(async () => finish())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('tbody')?.textContent).toContain('bob')
    expect(document.querySelector('tbody')?.textContent).toContain('Excluded')
    expect(document.body.textContent).not.toContain('Connection updated.')
    expect(mocks.api.deleteCiConnection).not.toHaveBeenCalled()
  })
  it('keeps a pending delete and its result scoped to the original organization', async () => {
    let finish!: () => void
    mocks.api.deleteCiConnection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await render('/dashboard/ci/connects')
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete connection to alice"]')!.click(),
    )
    await act(async () =>
      [...document.querySelectorAll('button')].find((item) => item.textContent === 'Delete connection')!.click(),
    )
    mocks.selection.selectedOrganization.id = 'account-b'
    await render('/dashboard/ci/connects')
    await act(async () => finish())
    expect(mocks.api.deleteCiConnection).toHaveBeenCalledExactlyOnceWith('account-a', 'binding')
    expect(document.querySelector('tbody')?.textContent).toContain('bob')
    expect(document.querySelector('tbody')?.textContent).not.toContain('alice')
    expect(document.body.textContent).not.toContain('Connection deleted.')
  })
})
