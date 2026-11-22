// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { useConsoleAnalytics } from './useConsoleAnalytics'
import { usePrivacyConsentStore } from './usePrivacyConsent'
import { incomingVisit, restoreVisit } from '@/lib/console-visit'

const sub = 'test-console-account'
const billing = vi.hoisted(() => ({ billingApiUrl: 'https://billing.example' }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ isAuthenticated: true, user: { profile: { sub } } }) }))
vi.mock('./useConfig', () => ({
  useConfig: () => ({ ...billing, posthog: { host: 'https://events.example', apiKey: 'project-key' } }),
}))

function Page() {
  useConsoleAnalytics()
  return <button data-console-action="new_box">customer content</button>
}

it.each([
  ['/dashboard/volumes', '/dashboard/volumes', undefined],
  ['/dashboard/images/private-image', '/dashboard/images/:idOrRef', undefined],
  ['/dashboard/domains', '/dashboard/domains', undefined],
  ['/dashboard/ci/connects', '/dashboard/ci/connects', undefined],
  ['/dashboard/billing?tab=wallet&coupon=private', '/dashboard/billing', 'wallet'],
  ['/dashboard/billing?tab=private', '/dashboard/billing', 'overview'],
  ['/dashboard/billing?tab=wallet', '/dashboard/billing', undefined, 'disabled'],
])('reports the console page for %s', (url, page, tab, availability) => {
  const send = vi.fn().mockResolvedValue(new Response())
  vi.stubGlobal('fetch', send)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.createElement('div'))
  try {
    if (availability === 'disabled') billing.billingApiUrl = ''
    const store = usePrivacyConsentStore.getState()
    store.init(sub)
    store.saveConsent({ ...store.preferences, analytics: true })
    act(() =>
      root.render(
        <MemoryRouter initialEntries={[url!]}>
          <Page />
        </MemoryRouter>,
      ),
    )
    expect(send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(send.mock.calls[0][1].body)
    expect(payload.event).toBe('$pageview')
    expect(payload.properties.$pathname).toBe(page)
    expect(payload.properties.billing_tab).toBe(tab)
    expect(JSON.stringify(payload)).not.toContain('private')
  } finally {
    billing.billingApiUrl = 'https://billing.example'
    act(() => root.unmount())
    localStorage.clear()
    vi.unstubAllGlobals()
  }
})

it('console analytics preserves an unseen source and stops dispatch after consent is withdrawn in another tab', () => {
  const send = vi.fn().mockResolvedValue(new Response())
  vi.stubGlobal('fetch', send)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const visit = incomingVisit('https://unknown.example/private?secret=test', 'https://app.example/?utm_source=readme')
    restoreVisit({ ...visit, unexpected: 'private callback value' })
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes/private-box']}>
          <Page />
        </MemoryRouter>,
      ),
    )
    expect(send).not.toHaveBeenCalled()
    const store = usePrivacyConsentStore.getState()
    act(() => store.saveConsent({ ...store.preferences, analytics: true }))
    host.querySelector('button')!.click()
    const bodies = send.mock.calls.map(([, request]) => JSON.parse(request.body))
    expect(bodies.map((body) => body.event)).toEqual(['$pageview', 'console_control_click'])
    expect(bodies[1].properties).toMatchObject({
      referring_domain: 'unknown.example',
      utm_source: 'readme',
      action: 'new_box',
      $pathname: '/dashboard/boxes/:boxId',
      visit_id: visit.visit_id,
    })
    expect(bodies[1].distinct_id).toBe(sub)
    expect(JSON.stringify(bodies)).not.toMatch(/private|secret=test|customer content/)
    // Another tab saved the preference; its storage notification has not arrived.
    localStorage.setItem('privacy_consent_' + sub, JSON.stringify({ ...store.preferences, analytics: false }))
    host.querySelector('button')!.click()
    expect(send).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    host.remove()
    localStorage.clear()
    vi.unstubAllGlobals()
  }
})
