// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Link } from 'react-router-dom'
import { getByRole, queryByRole } from '@testing-library/dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AnalyticsConsentCard,
  ProductAnalyticsProvider,
  ProductAnalyticsSettings,
} from '../ProductAnalyticsPreferences'
import { recordConsoleTabSelection } from '@/hooks/useConsoleAnalytics'

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ axiosInstance: http }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'organization' } }),
}))
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { profile: { sub: 'person' } } }),
}))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ posthog: { host: 'https://example.invalid', apiKey: 'phc_test' } }),
}))

let root: Root
let host: HTMLDivElement
let client: QueryClient
let allowed: boolean | null
const pause = () => new Promise<void>((r) => setTimeout(r, 5))

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/dashboard/boxes?secret=raw-query']}>
          <ProductAnalyticsProvider>
            <AnalyticsConsentCard />
            <ProductAnalyticsSettings />
            <button data-console-action="new_box">Private project name</button>
            <Link to="/dashboard/boxes/private-box-id?utm_source=private-referrer">Open private box</Link>
            <div className="xterm">
              <button>terminal content</button>
            </div>
          </ProductAnalyticsProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await act(pause)
}
async function click(name: string, role = 'button') {
  await act(async () => {
    getByRole(host, role, { name }).click()
    await pause()
  })
  await act(pause)
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  allowed = null
  http.get.mockImplementation(async () => ({
    data: { allowed, enabledFrom: allowed ? new Date(0).toISOString() : null },
  }))
  http.put.mockImplementation(async (_path, choice) => {
    allowed = choice.allowed
  })
  http.post.mockResolvedValue({})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  localStorage.clear()
})
it('starts off, ignores the old browser choice, and sends only subsequent sanitized activity', async () => {
  localStorage.setItem('privacy_consent_person', JSON.stringify({ analytics: true }))
  await mount()
  expect(getByRole(host, 'heading', { name: 'Share usage analytics?' })).toBeTruthy()
  await click('Private project name')
  await click('Allow analytics')
  expect(http.put).toHaveBeenCalledWith('/analytics/consent', { allowed: true, version: 1 })
  expect(http.post).not.toHaveBeenCalled()
  await click('terminal content')
  expect(http.post).not.toHaveBeenCalled()
  await click('Private project name')
  await act(async () => recordConsoleTabSelection('view_billing_wallet'))
  await click('Open private box', 'link')
  const events = http.post.mock.calls.map(([, e]) => e)
  expect(events.map((e) => e.event)).toEqual([
    'console_control_click',
    'console_control_click',
    'console_control_click',
    '$pageview',
  ])
  expect(events[0]).toMatchObject({ action: 'new_box', page: '/dashboard/boxes' })
  expect(events[1]).toMatchObject({ action: 'view_billing_wallet', control: 'tab' })
  expect(events[2].destination).toBe('/dashboard/boxes/:boxId')
  expect(events[3].page).toBe('/dashboard/boxes/:boxId')
  expect(JSON.stringify(events)).not.toMatch(
    /raw-query|private-box-id|private-referrer|Private project name|terminal content/,
  )
  await click('Product analytics', 'switch')
  expect(http.put).toHaveBeenLastCalledWith('/analytics/consent', { allowed: false, version: 1 })
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(4)
})
it('saves No thanks, hides the prompt, and leaves product interactions available', async () => {
  await mount()
  await click('No thanks')
  expect(queryByRole(host, 'heading', { name: 'Share usage analytics?' })).toBeNull()
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).getAttribute('aria-checked')).toBe('false')
  await click('Open private box', 'link')
  expect(http.post).not.toHaveBeenCalled()
})
it('honors an existing grant on the first admitted view and skips failed preference reads', async () => {
  allowed = true
  await mount()
  expect(http.post).toHaveBeenCalledTimes(1)
  expect(http.post.mock.calls[0][1]).toMatchObject({ event: '$pageview', page: '/dashboard/boxes' })
  http.get.mockRejectedValue(Error('offline'))
  await act(async () => {
    await client.invalidateQueries()
    await pause()
  })
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(1)
})
