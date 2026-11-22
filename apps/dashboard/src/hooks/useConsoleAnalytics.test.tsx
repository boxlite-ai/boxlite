// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { useConsoleAnalytics } from './useConsoleAnalytics'

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
    vi.unstubAllGlobals()
  }
})
