// @vitest-environment jsdom
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { useConsoleAnalytics } from './useConsoleAnalytics'
import { usePrivacyConsentStore } from './usePrivacyConsent'
import { incomingVisit, restoreVisit } from '@/lib/console-visit'

const config = vi.hoisted(() => ({ posthog: { host: '', apiKey: 'test-project' } }))
vi.mock('./useConfig', () => ({ useConfig: () => config }))
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { profile: { sub: 'member' } } }),
}))

function Page() {
  useConsoleAnalytics()
  return <button data-console-action="new_volume">New Volume</button>
}

it('delivers the consented visit and control action to the configured HTTP endpoint', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const received = vi.fn()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received(req.method, req.url, JSON.parse(Buffer.concat(chunks).toString()))
    res.end('1')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  config.posthog.host = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    const visit = incomingVisit('https://new-source.example/article', location.href)
    restoreVisit(visit)
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/volumes']}>
          <Page />
        </MemoryRouter>,
      ),
    )
    const consent = usePrivacyConsentStore.getState()
    act(() => consent.saveConsent({ ...consent.preferences, analytics: true }))
    host.querySelector('button')!.click()
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2))
    for (const event of ['$pageview', 'console_control_click']) {
      expect(received).toHaveBeenCalledWith(
        'POST',
        '/i/v0/e/',
        expect.objectContaining({
          api_key: 'test-project',
          distinct_id: 'member',
          event,
          properties: expect.objectContaining({
            visit_id: visit.visit_id,
            $pathname: '/dashboard/volumes',
            referring_domain: 'new-source.example',
            $set_once: { first_console_referring_domain: 'new-source.example' },
            ...(event === 'console_control_click' && { action: 'new_volume' }),
          }),
        }),
      )
    }
  } finally {
    act(() => root.unmount())
    host.remove()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    localStorage.clear()
    vi.unstubAllGlobals()
  }
})
