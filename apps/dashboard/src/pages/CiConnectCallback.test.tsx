// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { captureCiCallback, prepareCiRedirect } from '@/lib/ci-connect'
import CiConnectCallback from './CiConnectCallback'

const api = vi.hoisted(() => ({
  completeCiInstallation: vi.fn(),
  selectCiConnect: vi.fn(),
  completeCiConnect: vi.fn(async () => ({ status: 'connected', listener_status: 'provisioning' })),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
it('CI callback performs one authenticated completion under real React StrictMode', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const id = '12345678-1234-4234-8234-123456789abc',
    organization = '12345678-1234-4234-8234-123456789def'
  const state = id + '.' + 'A'.repeat(43)
  prepareCiRedirect(organization, {
    id,
    authorization_url: 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ state }),
    expires_at: new Date(Date.now() + 300000).toISOString(),
    installation_url: '',
  })
  window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'private-code', state }))
  captureCiCallback()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <MemoryRouter initialEntries={['/settings/ci/callback']}>
            <CiConnectCallback />
          </MemoryRouter>
        </StrictMode>,
      ),
    )
    expect(document.body.textContent).toContain('GitHub connected. Listener setup: provisioning.')
    expect(api.completeCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id, { code: 'private-code', state })
    expect(window.location.search).toBe('')
    expect(window.sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.sessionStorage.clear()
  }
})
