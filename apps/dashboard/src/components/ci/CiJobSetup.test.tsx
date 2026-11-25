// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CiJobSetup } from './CiJobSetup'
const mocks = vi.hoisted(() => ({
  api: { getCiSettings: vi.fn(), getCiRepositories: vi.fn() },
  selection: {
    selectedOrganization: { id: 'org', name: 'Demo Org' },
    authenticatedUserOrganizationMember: { role: 'owner' },
  },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selection }))
const connections = ['alice', 'bob'].map((account, i) => ({
  binding_id: account,
  github_account: account,
  account_type: 'User',
  installation_id: i + 1,
  installation_settings_url: `https://github.com/settings/installations/${i + 1}`,
  allow_private_repositories: false,
  listener_status: 'ready',
}))
describe('CI job setup context', () => {
  let root: Root, cache: QueryClient
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
  const button = (label: string) => [...document.querySelectorAll('button')].find((e) => e.textContent === label)!
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    mocks.selection.authenticatedUserOrganizationMember.role = 'owner'
    mocks.api.getCiSettings.mockResolvedValue({ available: true, connections })
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    cache.clear()
    document.body.innerHTML = ''
  })
  async function render() {
    const host = document.createElement('div')
    document.body.append(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <CiJobSetup />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    expect(mocks.api.getCiSettings).not.toHaveBeenCalled()
    await act(async () => button('How to run a job').click())
    await settle()
    await settle()
    expect(mocks.api.getCiRepositories).not.toHaveBeenCalled()
  }
  it('shows only organization context and never duplicates repository selection', async () => {
    await render()
    expect(document.body.textContent).toContain('GitHub connected · Demo Org')
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    await act(async () =>
      [...document.querySelectorAll('summary')].find((e) => e.textContent === 'Troubleshooting')!.click(),
    )
    await settle()
    expect(mocks.api.getCiRepositories).not.toHaveBeenCalled()
    expect(document.querySelector('a[href="/dashboard/ci/connects"]')?.textContent).toBe(
      'Check connections and repository access',
    )
  })
  it('offers setup before running when no GitHub accounts are connected', async () => {
    mocks.api.getCiSettings.mockResolvedValue({ available: true, connections: [] })
    await render()
    expect(document.body.textContent).toContain('Set up GitHub to run workflows on BoxLite.')
    expect(document.querySelector('a[href="/dashboard/ci/connects"]')?.textContent).toBe('Set up GitHub')
    expect(button('Copy runs-on').disabled).toBe(false)
  })
  it('keeps the workflow available after inventory failure and supports retry', async () => {
    mocks.api.getCiSettings.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(document.body.textContent).toContain('Couldn’t check your GitHub connection')
    expect(button('Copy runs-on').disabled).toBe(false)
    await act(async () => button('Retry connections').click())
    await settle()
    expect(document.body.textContent).toContain('GitHub connected · Demo Org')
  })
  it('does not fetch owner-only inventory for members', async () => {
    mocks.selection.authenticatedUserOrganizationMember.role = 'member'
    await render()
    expect(mocks.api.getCiSettings).not.toHaveBeenCalled()
    expect(mocks.api.getCiRepositories).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Ask an account owner')
    expect(button('Copy runs-on').disabled).toBe(false)
  })
  it('closes the guide when managing connections on the same route', async () => {
    await render()
    await act(async () =>
      [...document.querySelectorAll('summary')].find((e) => e.textContent === 'Troubleshooting')!.click(),
    )
    await settle()
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="/dashboard/ci/connects"]')!.click())
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
