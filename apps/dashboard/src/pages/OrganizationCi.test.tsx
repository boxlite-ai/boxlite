// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import OrganizationCi from './OrganizationCi'

const mocks = vi.hoisted(() => ({
  api: { getCiSettings: vi.fn(), setCiCapacity: vi.fn(), getCiConnectConfiguration: vi.fn(), startCiConnect: vi.fn() },
  selection: { selectedOrganization: { id: 'account-id' }, authenticatedUserOrganizationMember: { role: 'owner' } },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selection }))
describe('CI settings page', () => {
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
    mocks.selection.authenticatedUserOrganizationMember.role = 'owner'
    mocks.api.getCiSettings.mockResolvedValue(settings)
    mocks.api.getCiConnectConfiguration.mockResolvedValue({
      web_connect_available: true,
      installation_url: 'https://github.com/apps/test/installations/new',
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
            <OrganizationCi />
          </QueryClientProvider>
        </StrictMode>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  it('loads account capacity and existing connections, then saves zero and inherited limits', async () => {
    await render()
    expect(document.body.textContent).toContain('Effective limit: 5')
    expect(document.querySelector('tbody')?.textContent).toContain('alice')
    const input = document.querySelector<HTMLInputElement>('#ci-maximum')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '0')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.api.setCiCapacity).toHaveBeenLastCalledWith('account-id', 0)
    await act(async () => {
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.api.setCiCapacity).toHaveBeenLastCalledWith('account-id', null)
  })
  it('does not fetch configuration or offer actions to non-owners', async () => {
    mocks.selection.authenticatedUserOrganizationMember.role = 'member'
    await render()
    expect(mocks.api.getCiSettings).not.toHaveBeenCalled()
    expect(mocks.api.getCiConnectConfiguration).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Only account owners')
  })
  it('preserves the server allowance when browser authorization is not configured', async () => {
    mocks.api.getCiConnectConfiguration.mockResolvedValue({ web_connect_available: false })
    await render()
    expect(document.querySelector<HTMLButtonElement>('section:nth-child(2) button')?.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#ci-maximum')?.max).toBe('5')
    expect(document.body.textContent).toContain('Browser connect is not configured')
  })
})
