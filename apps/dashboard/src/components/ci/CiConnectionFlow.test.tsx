// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CiConnectionFlow } from './CiConnectionFlow'
import { prepareCiRedirect } from '@/lib/ci-connect'

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
    cache.clear()
    document.body.innerHTML = ''
    sessionStorage.clear()
    history.replaceState({}, '', '/')
  })
  async function render(resume = false) {
    if (resume) {
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
  it('starts identity OAuth directly and always releases the start button', async () => {
    await render()
    await act(async () => button('Connect GitHub').click())
    expect(api.startCiConnect).toHaveBeenCalledExactlyOnceWith(organization, {
      follow_installation: true,
      allow_public_repositories: false,
      select_account: false,
    })
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(button('Connect GitHub').disabled).toBe(false)
    expect(prepareCiRedirect).toHaveBeenCalledOnce()
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
    await act(async () => window.dispatchEvent(new Event('pageshow')))
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
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Unable to start')
    expect(button('Back to Connects').disabled).toBe(false)
    expect(document.querySelector('[data-slot=dialog-close]')).not.toBeNull()
  })
  it('keeps previously discovered choices and organization recovery after a provider access failure', async () => {
    await render(true)
    expect(document.querySelector('[data-account-id="1"]')).not.toBeNull()
    api.getCiConnect.mockRejectedValue(Error('403 organization access'))
    await act(async () => window.dispatchEvent(new Event('pageshow')))
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
