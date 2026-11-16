// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCiRedirect, getCiConnectSession } from '@/lib/ci-connect'
import { ConnectsPanel } from './ConnectsPanel'

const mocks = vi.hoisted(() => ({
  api: {
    getCiRepositories: vi.fn(),
    getCiSettings: vi.fn(),
    setCiCapacity: vi.fn(),
    getCiConnectConfiguration: vi.fn(),
    startCiConnect: vi.fn(),
    cancelCiConnect: vi.fn(),
    deleteCiConnection: vi.fn(),
    updateCiConnection: vi.fn(),
  },
  selection: { selectedOrganization: { id: 'account-id' }, authenticatedUserOrganizationMember: { role: 'owner' } },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selection }))
describe('CI connects panel', () => {
  let root: Root, cache: QueryClient
  const settings = {
    available: true,
    max_concurrent_jobs: null,
    commerce_limit: 5,
    effective_limit: 5,
    connections: [
      {
        installation_id: 11,
        installation_settings_url: 'https://github.com/settings/installations/11',
        binding_id: 'binding',
        github_account: 'alice',
        listener_status: 'ready',
        allow_private_repositories: true,
      },
    ],
  }
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
    )
    mocks.api.getCiRepositories.mockResolvedValue({
      repositories: [],
      total: 0,
      page: 1,
      next_page: null,
      repository_selection: 'selected',
    })
    sessionStorage.clear()
    mocks.api.cancelCiConnect.mockReset().mockResolvedValue(undefined)
    mocks.api.deleteCiConnection.mockReset().mockResolvedValue(undefined)
    mocks.api.updateCiConnection.mockReset().mockResolvedValue(undefined)
    mocks.selection.authenticatedUserOrganizationMember.role = 'owner'
    mocks.api.getCiSettings.mockResolvedValue(settings)
    mocks.api.getCiConnectConfiguration.mockResolvedValue({
      web_connect_available: true,
      apps: [
        {
          account_type: 'User',
          web_connect_available: true,
          installation_url: 'https://github.com/apps/test/installations/new',
        },
      ],
    })
    mocks.api.setCiCapacity.mockImplementation(async (_org, value) => ({
      ...settings,
      max_concurrent_jobs: value,
      effective_limit: value ?? 5,
    }))
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    vi.unstubAllGlobals()
    cache.clear()
    document.body.innerHTML = ''
  })
  async function render() {
    const node = document.createElement('div')
    document.body.append(node)
    await act(async () => {
      root = createRoot(node)
      root.render(
        <StrictMode>
          <QueryClientProvider client={cache}>
            <MemoryRouter>
              <ConnectsPanel />
            </MemoryRouter>
          </QueryClientProvider>
        </StrictMode>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
  it('restores the connect action on browser back while authorization start is pending', async () => {
    let fail!: (reason: unknown) => void
    mocks.api.startCiConnect.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    await render()
    await act(async () => button('Connect GitHub').click())
    if (button('Authorize GitHub')) await act(async () => button('Authorize GitHub').click())
    expect(mocks.api.startCiConnect).toHaveBeenCalledTimes(1)
    try {
      await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      expect(button('Connect GitHub').disabled).toBe(false)
    } finally {
      await act(async () => fail(Error('test completion')))
    }
  })
  function pendingAttempt() {
    const id = '12345678-1234-4234-8234-123456789abc'
    prepareCiRedirect('12345678-1234-4234-8234-123456789def', {
      id,
      expires_at: new Date(Date.now() + 300000).toISOString(),
      installation_url: '',
      authorization_url: 'https://github.com/login/oauth/authorize?state=' + id + '.' + 'A'.repeat(43),
    })
    return id
  }
  it('does not cancel an active picker on the initial pageshow event', async () => {
    const id = pendingAttempt()
    await render()
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })))
    expect(getCiConnectSession()?.attempt).toBe(id)
    expect(mocks.api.cancelCiConnect).not.toHaveBeenCalled()
  })
  it('offers explicit recovery when a stale authorization cannot be cancelled', async () => {
    pendingAttempt()
    mocks.api.cancelCiConnect.mockRejectedValue(Error('access lost'))
    await render()
    await act(async () => button('Connect GitHub').click())
    expect(mocks.api.startCiConnect).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('could not be cancelled')
    expect(button('Discard local authorization')).toBeDefined()
    await act(async () => button('Discard local authorization').click())
    expect(getCiConnectSession()).toBeUndefined()
    mocks.api.startCiConnect.mockRejectedValueOnce(Error('test stop'))
    await act(async () => button('Connect GitHub').click())
    expect(mocks.api.startCiConnect).toHaveBeenCalledTimes(1)
  })
  it('expands and collapses repository inventory without changing the connection', async () => {
    mocks.api.getCiSettings.mockResolvedValue({
      ...settings,
      connections: [{ ...settings.connections[0], account_type: 'Organization', listener_status: 'provisioning' }],
    })
    await render()
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Repositories for alice"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('tbody')?.textContent).toContain('Organization')
    expect(document.querySelector('tbody')?.textContent).toContain('Provisioning')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(mocks.api.getCiRepositories).toHaveBeenCalled()
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(mocks.api.updateCiConnection).not.toHaveBeenCalled()
  })
  it('retries a failed configuration read while keeping connected accounts visible', async () => {
    mocks.api.getCiConnectConfiguration.mockRejectedValueOnce(Error('offline'))
    await render()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.body.textContent).toContain('Unable to load GitHub App configuration')
    await act(async () => button('Retry GitHub configuration').click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(mocks.api.getCiConnectConfiguration).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Unable to load GitHub App configuration')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
  })
  it('retains connection inventory on refresh failure and retries explicitly', async () => {
    await render()
    mocks.api.getCiSettings.mockRejectedValueOnce(Error('offline'))
    await act(async () => cache.invalidateQueries({ queryKey: ['ci-settings'] }))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.body.textContent).toContain('Could not refresh connections')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    const attempts = mocks.api.getCiSettings.mock.calls.length
    await act(async () => button('Retry').click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.body.textContent).not.toContain('Could not refresh connections')
    expect(mocks.api.getCiSettings).toHaveBeenCalledTimes(attempts + 1)
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
  })

  it('shows connections without capacity controls', async () => {
    await render()
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    expect(button('Capacity')).toBeUndefined()
    expect(button('Edit limit')).toBeUndefined()
  })
  it('filters account names without case sensitivity and restores results after clearing', async () => {
    await render()
    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter connections"]')!
    expect(input).not.toBeNull()
    const filter = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await filter(' ALICE ')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    await filter('missing')
    expect(document.querySelector('table')).toBeNull()
    expect(document.body.textContent).toContain('No matching connections')
    expect(button('Clear filter')).toBeDefined()
    await act(async () => button('Clear filter').click())
    expect(input.value).toBe('')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
  })
  it('preserves an unfamiliar listener state as supplied by the server', async () => {
    mocks.api.getCiSettings.mockResolvedValue({
      ...settings,
      connections: [{ ...settings.connections[0], listener_status: 'awaiting_policy' }],
    })
    await render()
    expect(document.querySelector('tbody')?.textContent).toContain('awaiting_policy')
    expect(document.querySelector('tbody')?.textContent).not.toContain('Ready')
  })
  it('offers repository access repair from an existing connection Update', async () => {
    await render()
    await act(async () => button('Update').click())
    const link = document.querySelector('[role="dialog"] a')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Install app for repos')
    expect(mocks.api.deleteCiConnection).not.toHaveBeenCalled()
  })
  it('confirms deletion, keeps cancellation local and suppresses duplicate requests', async () => {
    let finish!: () => void
    mocks.api.deleteCiConnection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    mocks.api.getCiSettings.mockResolvedValueOnce(settings).mockResolvedValue({ ...settings, connections: [] })
    await render()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete connection to alice"]')!.click(),
    )
    await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click())
    expect(mocks.api.deleteCiConnection).not.toHaveBeenCalled()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete connection to alice"]')!.click(),
    )
    await act(async () => {
      button('Delete connection').click()
      button('Delete connection').click()
    })
    expect(mocks.api.deleteCiConnection).toHaveBeenCalledExactlyOnceWith('account-id', 'binding')
    await act(async () => finish())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[aria-label="Repositories for alice"]')).toBeNull()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
  it('opens a prefilled policy update, cancels locally and saves without deleting the connection', async () => {
    await render()
    await act(async () => button('Update').click())
    expect(
      document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')?.getAttribute('aria-checked'),
    ).toBe('true')
    await act(async () => button('Cancel').click())
    expect(mocks.api.updateCiConnection).not.toHaveBeenCalled()
    await act(async () => button('Update').click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')!.click())
    mocks.api.getCiSettings.mockResolvedValue({
      ...settings,
      connections: [{ ...settings.connections[0], allow_private_repositories: false }],
    })
    await act(async () => button('Update connection').click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(mocks.api.updateCiConnection).toHaveBeenCalledExactlyOnceWith('account-id', 'binding', false)
    expect(mocks.api.deleteCiConnection).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('tbody')?.textContent).toContain('Excluded')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
  })
  it('keeps failed policy edits and suppresses duplicate updates', async () => {
    let fail!: (reason: unknown) => void
    mocks.api.updateCiConnection.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    await render()
    await act(async () => button('Update').click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')!.click())
    await act(async () => {
      button('Update connection').click()
      button('Update connection').click()
    })
    expect(mocks.api.updateCiConnection).toHaveBeenCalledExactlyOnceWith('account-id', 'binding', false)
    await act(async () => fail(Error('unavailable')))
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'Unable to update this connection',
    )
    expect(
      document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')?.getAttribute('aria-checked'),
    ).toBe('false')
  })
  it('keeps a failed delete actionable inside its confirmation dialog', async () => {
    mocks.api.deleteCiConnection.mockRejectedValueOnce(Error('unavailable'))
    await render()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete connection to alice"]')!.click(),
    )
    await act(async () => button('Delete connection').click())
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Unable to delete this connection')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
  })
  it('does not fetch configuration or offer actions to non-owners', async () => {
    mocks.selection.authenticatedUserOrganizationMember.role = 'member'
    await render()
    expect(mocks.api.getCiSettings).not.toHaveBeenCalled()
    expect(mocks.api.getCiConnectConfiguration).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Only account owners')
  })
  it('preserves the server allowance when browser authorization is not configured', async () => {
    mocks.api.getCiConnectConfiguration.mockResolvedValue({
      apps: [{ account_type: 'User', web_connect_available: false }],
    })
    await render()
    await act(async () => button('Connect GitHub').click())
    expect(button('Connect GitHub').disabled).toBe(true)
    expect(document.body.textContent).toContain('Browser connect is not configured')
    expect(document.querySelector('#ci-maximum')).toBeNull()
  })
})
