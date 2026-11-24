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
  useSelectedOrganization: () => ({ selectedOrganization: { id: organizationId } }),
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
let organizationId: string
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
  organizationId = 'organization'
  allowed = null
  http.get.mockImplementation(async () => ({
    data: { allowed, enabledFrom: allowed ? new Date(0).toISOString() : null },
  }))
  http.put.mockImplementation(async (_path, choice) => {
    allowed = choice.allowed
    return { data: { allowed, version: 1, decidedAt: new Date().toISOString() } }
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

it('keeps the confirmed grant active when a withdrawal fails and allows a retry', async () => {
  allowed = true
  await mount()
  const alreadySent = http.post.mock.calls.length
  http.put.mockRejectedValueOnce(new Error('network unavailable'))
  await click('Product analytics', 'switch')
  expect(getByRole(host, 'alert').textContent).toContain('Could not confirm your preference')
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(alreadySent + 1)
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).getAttribute('aria-checked')).toBe('true')
  await click('Product analytics', 'switch')
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).getAttribute('aria-checked')).toBe('false')
  expect(queryByRole(host, 'alert')).toBeNull()
})

it('collects until withdrawal succeeds and stops across cached organizations on acknowledgement', async () => {
  allowed = true
  await mount()
  http.post.mockClear()

  const withdrawal = Promise.withResolvers<void>()
  http.put.mockImplementationOnce(async () => {
    await withdrawal.promise
    allowed = false
    return { data: { allowed, version: 1, decidedAt: new Date().toISOString() } }
  })
  await click('Product analytics', 'switch')
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(1)

  organizationId = 'other-org'
  await mount()
  const beforeWithdrawal = http.post.mock.calls.length

  // Hold a GET started under the old grant across the acknowledged withdrawal.
  const oldRead = Promise.withResolvers<void>()
  http.get.mockImplementationOnce(async () => {
    await oldRead.promise
    return { data: { allowed: true, enabledFrom: new Date(0).toISOString() } }
  })
  await act(async () => {
    void client.invalidateQueries()
    await pause()
  })
  await act(async () => {
    withdrawal.resolve()
    await pause()
    oldRead.resolve()
    await pause()
  })
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).getAttribute('aria-checked')).toBe('false')
  await click('Private project name')

  organizationId = 'organization'
  await mount()
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(beforeWithdrawal)
})

it('can retry after a failed preference read and keeps a saved refusal off', async () => {
  allowed = false
  http.get.mockRejectedValueOnce(new Error('offline'))
  await mount()
  expect(getByRole(host, 'alert').textContent).toContain('Could not load your preference')
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).hasAttribute('disabled')).toBe(true)
  await click('Refresh')
  expect(queryByRole(host, 'alert')).toBeNull()
  expect(queryByRole(host, 'heading', { name: 'Share usage analytics?' })).toBeNull()
  expect(getByRole(host, 'switch', { name: 'Product analytics' }).getAttribute('aria-checked')).toBe('false')
  expect(http.post).not.toHaveBeenCalled()
})

it('drops excess clicks while requests are outstanding and resumes after transport failure', async () => {
  allowed = true
  await mount()
  http.post.mockClear()
  let finish!: () => void
  const pending = new Promise<void>((_, reject) => {
    finish = () => reject(new Error('transport unavailable'))
  })
  http.post.mockReturnValue(pending)
  await click('Private project name')
  await click('Private project name')
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(2)
  await act(async () => {
    finish()
    await pause()
  })
  http.post.mockResolvedValue({})
  await click('Private project name')
  expect(http.post).toHaveBeenCalledTimes(3)
})
