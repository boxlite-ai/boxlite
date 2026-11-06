// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectsPanel } from './ConnectsPanel'

const mocks = vi.hoisted(() => ({
  api: {
    getCiSettings: vi.fn(),
    setCiCapacity: vi.fn(),
    getCiConnectConfiguration: vi.fn(),
    startCiConnect: vi.fn(),
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
      { binding_id: 'binding', github_account: 'alice', listener_status: 'ready', allow_public_repositories: true },
    ],
  }
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
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
      await act(async () => window.dispatchEvent(new Event('pageshow')))
      expect(button('Connect GitHub').disabled).toBe(false)
    } finally {
      await act(async () => fail(Error('test completion')))
    }
  })
  it('shows connections without capacity controls', async () => {
    await render()
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    expect(button('Capacity')).toBeUndefined()
    expect(button('Edit')).toBeUndefined()
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
    expect(document.querySelector('tbody')?.textContent).not.toContain('alice')
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
  it('opens a prefilled policy update, cancels locally and saves without deleting the connection', async () => {
    await render()
    await act(async () => button('Update').click())
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')?.checked).toBe(true)
    await act(async () => button('Cancel').click())
    expect(mocks.api.updateCiConnection).not.toHaveBeenCalled()
    await act(async () => button('Update').click())
    await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click())
    mocks.api.getCiSettings.mockResolvedValue({
      ...settings,
      connections: [{ ...settings.connections[0], allow_public_repositories: false }],
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
    await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click())
    await act(async () => {
      button('Update connection').click()
      button('Update connection').click()
    })
    expect(mocks.api.updateCiConnection).toHaveBeenCalledExactlyOnceWith('account-id', 'binding', false)
    await act(async () => fail(Error('unavailable')))
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'Unable to update this connection',
    )
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')?.checked).toBe(false)
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
