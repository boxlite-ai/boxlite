// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Domains from './Domains'
import type { DomainList, HeldDomain } from '@/api/domain-types'

const state = vi.hoisted(() => ({
  organizationId: 'org-1',
  canManage: true,
  list: vi.fn(),
  claim: vi.fn(),
  custom: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ listDomains: state.list, claimDomain: state.claim, listCustomDomains: state.custom }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: state.organizationId },
    authenticatedUserHasPermission: () => state.canManage,
  }),
}))

const list: DomainList = {
  domains: [
    {
      hostname: 'web-one.apps.test',
      url: 'https://web-one.apps.test',
      target: { type: 'box', box: 'box-123', port: 3000 },
    },
    { hostname: 'shop-one.apps.test', url: 'https://shop-one.apps.test', target: { type: 'app', app: 'shop-app' } },
    { hostname: 'spare.apps.test', url: 'https://spare.apps.test', target: null },
  ],
  limit: 5,
  used: 3,
  remaining: 2,
  min_length: 5,
  domain_suffix: 'apps.test',
}

describe('Domains page', () => {
  let root: Root
  let client: QueryClient
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    state.organizationId = 'org-1'
    state.canManage = true
    state.list.mockReset().mockResolvedValue(list)
    state.custom.mockReset().mockResolvedValue({ enabled: false, subscription: 'required', domains: [] })
    state.claim
      .mockReset()
      .mockResolvedValue({ hostname: 'my-app.apps.test', url: 'https://my-app.apps.test', target: null })
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    document.body.innerHTML = ''
  })

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  async function render() {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Domains />
        </QueryClientProvider>,
      ),
    )
    await settle()
  }
  async function openForm() {
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    const input = document.querySelector<HTMLInputElement>('#domain-short-name')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My-App')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function submit() {
    await act(async () =>
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    await settle()
  }

  it('lists full names with Box/port, App, and unbound targets', async () => {
    await render()
    expect(state.list).toHaveBeenCalledWith('org-1')
    const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent)
    expect(rows).toEqual([
      'web-one.apps.testBoxbox-1233000',
      'shop-one.apps.testAppshop-app—',
      'spare.apps.testUnbound——',
    ])
    expect(document.body.textContent).toContain('3 / 5 platform domains held')
  })

  it('previews a full hostname from a short name, claims it and refreshes the list', async () => {
    await render()
    await openForm()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('my-app.apps.test')
    await submit()
    expect(state.claim).toHaveBeenCalledWith('org-1', 'my-app')
    expect(document.body.textContent).toContain('Domain acquired: my-app.apps.test')
    expect(state.list).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows request refusals and keeps the form available for correction', async () => {
    state.claim.mockRejectedValue(new Error('my-app.apps.test is not available.'))
    await render()
    await openForm()
    await submit()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('not available')
    expect(document.querySelector('form')).not.toBeNull()
  })

  it.each([
    { ...list, remaining: 0 },
    { ...list, domain_suffix: null },
  ])('disables requests when quota or platform configuration disallows them', async (response) => {
    state.list.mockResolvedValue(response)
    await render()
    expect(document.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  })

  it('requires permission before fetching or requesting domains', async () => {
    state.canManage = false
    await render()
    expect(state.list).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Box write permission')
    expect(document.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  })

  it('renders empty and fetch-error states', async () => {
    state.list.mockResolvedValue({ ...list, domains: [], used: 0, remaining: 5 })
    await render()
    expect(document.body.textContent).toContain('No domains yet')
    state.organizationId = 'org-error'
    state.list.mockRejectedValue(new Error('Network unavailable'))
    await render()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable')
  })

  it('isolates lists and late claim results when switching organizations', async () => {
    let resolveClaim!: (domain: HeldDomain) => void
    state.claim.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClaim = resolve
        }),
    )
    await render()
    await openForm()
    await submit()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    state.organizationId = 'org-2'
    state.list.mockResolvedValue({ ...list, domains: [], used: 0 })
    await render()
    expect(document.body.textContent).not.toContain('web-one.apps.test')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => resolveClaim({ hostname: 'late.apps.test', url: 'https://late.apps.test', target: null }))
    await settle()
    expect(document.body.textContent).not.toContain('late.apps.test')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['domains', 'org-1', 'list'] })
    expect(state.list).toHaveBeenLastCalledWith('org-2')
  })
})
