// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CiConnectionFlow } from './CiConnectionFlow'
import { prepareCiRedirect, getCiConnectSession } from '@/lib/ci-connect'
import CiConnectCallback from '@/pages/CiConnectCallback'

const api = vi.hoisted(() => ({
  startCiConnect: vi.fn(),
  cancelCiConnect: vi.fn(),
  getCiConnect: vi.fn(),
  selectCiAccount: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
vi.mock('@/lib/ci-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ci-connect')>()
  return {
    ...actual,
    prepareCiRedirect: vi.fn((...args: Parameters<typeof actual.prepareCiRedirect>) => {
      actual.prepareCiRedirect(...args)
      return '#simulated-oauth'
    }),
  }
})
describe('CI browser connection lifecycle', () => {
  let root: Root, cache: QueryClient
  const organization = '12345678-1234-4234-8234-123456789def',
    id = '12345678-1234-4234-8234-123456789abc'
  const grant = () => ({
    id,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    authorization_url: 'https://github.com/login/oauth/authorize?state=' + id + '.' + 'A'.repeat(43),
  })
  const result = {
    id,
    status: 'selection_required',
    authenticated_account: 'alice',
    accounts: [
      {
        account_id: 1,
        github_account: 'alice',
        account_type: 'User',
        installation_id: 11,
        installed: true,
        connected: false,
      },
    ],
  }
  const configuration = {
    web_connect_available: true,
    authorization_settings_url: 'https://github.com/settings/connections/applications/identity-client',
    apps: [],
  }
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === text)!
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    sessionStorage.clear()
    history.replaceState({}, '', '/')
    api.startCiConnect.mockReset().mockResolvedValue(grant())
    api.cancelCiConnect.mockReset().mockResolvedValue({ status: 'cancelled' })
    api.getCiConnect.mockReset().mockResolvedValue(result)
    api.selectCiAccount.mockReset()
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    vi.useRealTimers()
    cache.clear()
    document.body.innerHTML = ''
    sessionStorage.clear()
    history.replaceState({}, '', '/')
  })
  async function render(resume = false, stored = true) {
    if (resume && stored) {
      prepareCiRedirect(organization, grant())
      vi.mocked(prepareCiRedirect).mockClear()
    }
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={cache}>
            <MemoryRouter initialEntries={['/dashboard/ci/connects' + (resume ? '?connect=' + id : '')]}>
              <CiConnectionFlow organization={organization} configuration={configuration} />
            </MemoryRouter>
          </QueryClientProvider>
        </StrictMode>,
      ),
    )
  }
  it('refuses a resumed route without matching browser metadata', async () => {
    await render(true, false)
    expect(api.getCiConnect).not.toHaveBeenCalled()
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Authorization expired')
    await act(async () => button('Back to Connects').click())
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it.each(['failed', 'unavailable'])('keeps a failed initial account read actionable: %s', async (status) => {
    if (status === 'unavailable') api.getCiConnect.mockRejectedValue(Error('unavailable'))
    else api.getCiConnect.mockResolvedValue({ id, status })
    await render(true)
    expect(document.querySelector('[role=alert]')?.textContent).toContain(
      status === 'failed' ? 'Authorization did not complete' : 'Unable to read GitHub accounts',
    )
    expect(document.querySelector('summary')?.textContent).toBe('Missing an organization?')
  })
  it.each(['selection_required', 'pending', 'failed'])('renders the account mutation outcome: %s', async (status) => {
    api.selectCiAccount.mockResolvedValue({ ...result, status })
    await render(true)
    await act(async () => button('Connect').click())
    expect(api.selectCiAccount).toHaveBeenCalledTimes(1)
    if (status === 'selection_required' || status === 'pending')
      expect(document.querySelector('[role=alert]')).toBeNull()
    else
      expect(document.querySelector('[role=alert]')?.textContent).toContain(
        status === 'pending' ? 'Another connection request' : 'Authorization did not complete',
      )
  })
  it('polls a resumed pending connection until GitHub finishes it', async () => {
    vi.useFakeTimers()
    api.getCiConnect.mockResolvedValue({ id, status: 'pending' })
    await render(true)
    const reads = api.getCiConnect.mock.calls.length
    api.getCiConnect.mockResolvedValue({ id, status: 'connected', listener_status: 'ready' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.getCiConnect.mock.calls.length).toBeGreaterThan(reads)
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(getCiConnectSession()).toBeUndefined()
  })
  it('continues polling after the actual callback route recovers a pending authorization', async () => {
    vi.useFakeTimers()
    prepareCiRedirect(organization, grant())
    api.getCiConnect.mockResolvedValue({ id, status: 'pending' })
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={['/settings/ci/callback']}>
            <Routes>
              <Route path="/settings/ci/callback" element={<CiConnectCallback />} />
              <Route
                path="/dashboard/ci/connects"
                element={<CiConnectionFlow organization={organization} configuration={configuration} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    expect(document.querySelector('[role=status]')?.textContent).toContain('Finishing GitHub connection')
    api.getCiConnect.mockResolvedValue({ id, status: 'connected', listener_status: 'ready' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(getCiConnectSession()).toBeUndefined()
  })
  it('stops pending polling after closing the dialog or expiry', async () => {
    vi.useFakeTimers()
    api.getCiConnect.mockResolvedValue({ id, status: 'pending' })
    await render(true)
    const reads = api.getCiConnect.mock.calls.length
    await act(async () => {
      vi.setSystemTime(Date.now() + 300001)
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Authorization expired')
    expect(api.getCiConnect).toHaveBeenCalledTimes(reads)
    await act(async () => button('Back to Connects').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(api.getCiConnect).toHaveBeenCalledTimes(reads)
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('lets the user retry a failed pending status read', async () => {
    vi.useFakeTimers()
    api.getCiConnect.mockResolvedValue({ id, status: 'pending' })
    await render(true)
    api.getCiConnect.mockRejectedValueOnce(Error('temporary network failure'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(button('Retry authorization status')).toBeDefined()
    api.getCiConnect.mockResolvedValue(result)
    await act(async () => button('Retry authorization status').click())
    expect(document.querySelector('[role=alert]')).toBeNull()
    expect(button('Connect')).toBeDefined()
  })
  it('starts identity OAuth directly and always releases the start button', async () => {
    await render()
    await act(async () => button('Connect GitHub').click())
    expect(api.startCiConnect).toHaveBeenCalledExactlyOnceWith(organization, {
      follow_installation: true,
      allow_private_repositories: false,
      select_account: false,
    })
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(button('Connect GitHub').disabled).toBe(false)
    expect(prepareCiRedirect).toHaveBeenCalledOnce()
  })
  it('keeps a pending start through the initial pageshow event', async () => {
    let finish!: (value: ReturnType<typeof grant>) => void
    api.startCiConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    await act(async () => button('Connect GitHub').click())
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })))
    expect(button('Connect GitHub').disabled).toBe(true)
    await act(async () => finish(grant()))
    expect(prepareCiRedirect).toHaveBeenCalledTimes(1)
    expect(api.cancelCiConnect).not.toHaveBeenCalled()
  })
  it('keeps one connect action during startup and restores it after failure', async () => {
    let fail!: (reason: unknown) => void
    api.startCiConnect.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    await render()
    const connect = button('Connect GitHub')
    await act(async () => connect.click())
    try {
      expect(button('Cancel')).toBeUndefined()
      expect(button('Connect GitHub')).toBe(connect)
      expect(connect.disabled).toBe(true)
      expect(connect.querySelector('svg.animate-spin')).not.toBeNull()
      await act(async () => connect.click())
      expect(api.startCiConnect).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => fail(Error('Authorization request failed')))
    }
    expect(button('Connect GitHub').disabled).toBe(false)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Unable to start')
  })
  it('cancels a late start without redirecting after browser restoration', async () => {
    let finish!: (value: ReturnType<typeof grant>) => void
    api.startCiConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    await act(async () => button('Connect GitHub').click())
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await act(async () => finish(grant()))
    expect(prepareCiRedirect).not.toHaveBeenCalled()
    expect(api.cancelCiConnect).toHaveBeenCalledWith(organization, id)
    expect(button('Connect GitHub').disabled).toBe(false)
  })
  it('cancels the previous grant before starting a forced GitHub account picker', async () => {
    await render(true)
    await act(async () => button('Switch account').click())
    expect(api.cancelCiConnect).toHaveBeenCalledWith(organization, id)
    expect(api.startCiConnect).toHaveBeenCalledExactlyOnceWith(
      organization,
      expect.objectContaining({ select_account: true }),
    )
    expect(api.cancelCiConnect.mock.invocationCallOrder[0]).toBeLessThan(api.startCiConnect.mock.invocationCallOrder[0])
  })
  it('keeps an exit and reports failed cancellation without starting another grant', async () => {
    await render(true)
    api.cancelCiConnect.mockRejectedValueOnce(Error('unavailable'))
    await act(async () => button('Switch account').click())
    expect(api.startCiConnect).not.toHaveBeenCalled()
    expect(document.querySelector('[role=alert]')?.textContent).toContain('could not be cancelled')
    expect(button('Back to Connects').disabled).toBe(false)
    expect(button('Discard local authorization').closest('[role=dialog]')).not.toBeNull()
    expect(document.querySelector('[data-slot=dialog-close]')).not.toBeNull()
  })
  it('keeps previously discovered choices and organization recovery after a provider access failure', async () => {
    await render(true)
    expect(document.querySelector('[data-account-id="1"]')).not.toBeNull()
    api.getCiConnect.mockRejectedValue(Error('403 organization access'))
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    expect(document.querySelector('[data-account-id="1"]')).not.toBeNull()
    expect(document.querySelector('summary')?.textContent).toBe('Missing an organization?')
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Review organization access and SSO')
  })
  it('closes and cancels while a connection request is pending, ignoring the late result', async () => {
    let finish!: (value: typeof result) => void
    api.selectCiAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render(true)
    await act(async () => button('Connect').click())
    await act(async () => button('Back to Connects').click())
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(api.cancelCiConnect).toHaveBeenCalledWith(organization, id)
    await act(async () => finish(result))
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
})
