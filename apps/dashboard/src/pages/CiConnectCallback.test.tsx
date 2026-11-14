// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { captureCiCallback, prepareCiRedirect } from '@/lib/ci-connect'
import CiConnectCallback from './CiConnectCallback'

const api = vi.hoisted(() => ({
  completeCiInstallation: vi.fn(),
  selectCiConnect: vi.fn(),
  getCiConnect: vi.fn(),
  cancelCiConnect: vi.fn().mockResolvedValue(undefined),
  completeCiConnect: vi.fn(async () => ({ status: 'connected', listener_status: 'provisioning' })),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'callback-user' } } }) }))
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
    expect(JSON.parse(sessionStorage.getItem('boxlite-organization-session') || 'null')).toEqual({
      userId: 'callback-user',
      organizationId: organization,
    })
    expect(window.location.search).toBe('')
    expect(window.sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.sessionStorage.clear()
  }
})

it('keeps an exit available while GitHub completion is pending', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const id = '12345678-1234-4234-8234-123456789abc',
    organization = '12345678-1234-4234-8234-123456789def'
  const state = id + '.' + 'A'.repeat(43)
  let finish!: (value: any) => void
  api.completeCiConnect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
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
        <MemoryRouter>
          <CiConnectCallback />
        </MemoryRouter>,
      ),
    )
    expect(document.querySelector('a[href="/dashboard/ci/connects"]')).not.toBeNull()
  } finally {
    await act(async () => finish({ status: 'cancelled' }))
    await act(async () => root.unmount())
    host.remove()
    sessionStorage.clear()
  }
})

it.each(['modifier', 'storage'])('handles callback recovery: %s', async (scenario) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  api.cancelCiConnect.mockClear()
  const id = '12345678-1234-4234-8234-123456789abc',
    organization = '12345678-1234-4234-8234-123456789def'
  const state = id + '.' + 'A'.repeat(43)
  prepareCiRedirect(organization, {
    id,
    authorization_url: 'https://github.com/login/oauth/authorize?state=' + state,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    installation_url: '',
  })
  window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'code', state }))
  captureCiCallback()
  let finish!: (value: any) => void
  api.completeCiConnect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const original = Storage.prototype.setItem
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (scenario === 'storage' && this === sessionStorage && key === 'boxlite-organization-session')
      throw new DOMException('full', 'QuotaExceededError')
    return original.call(this, key, value)
  })
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <CiConnectCallback />
        </MemoryRouter>,
      ),
    )
    if (scenario === 'modifier') {
      await act(async () =>
        host
          .querySelector('a')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })),
      )
      expect(api.cancelCiConnect).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('boxlite.ci.connect')).not.toBeNull()
    } else {
      await act(async () => finish({ status: 'connected', listener_status: 'ready' }))
      expect(host.textContent).not.toContain('Verifying GitHub authorization')
      expect(host.textContent).toContain('GitHub connected')
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('organization')
      expect(host.querySelector('button')?.textContent).toContain('Retry')
      expect(sessionStorage.getItem('boxlite-organization-session')).toBeNull()
      spy.mockRestore()
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
      expect(host.querySelector('[role=alert]')).toBeNull()
      expect(JSON.parse(sessionStorage.getItem('boxlite-organization-session') || 'null')).toEqual({
        userId: 'callback-user',
        organizationId: organization,
      })
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    spy.mockRestore()
    sessionStorage.clear()
  }
})

it.each(['retry', 'back', 'failed', 'install'])('keeps callback recovery actionable: %s', async (scenario) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  api.completeCiConnect.mockReset()
  api.cancelCiConnect.mockReset().mockResolvedValue(undefined)
  api.getCiConnect.mockReset()
  const id = '12345678-1234-4234-8234-123456789abc',
    organization = '12345678-1234-4234-8234-123456789def'
  const state = id + '.' + 'A'.repeat(43)
  prepareCiRedirect(organization, {
    id,
    authorization_url: 'https://github.com/login/oauth/authorize?state=' + state,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    installation_url: '',
  })
  history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'code', state }))
  captureCiCallback()
  if (scenario === 'retry') {
    api.completeCiConnect.mockRejectedValueOnce(Error('response lost'))
    api.getCiConnect.mockResolvedValueOnce({ id, status: 'selection_required' })
  } else if (scenario === 'back') api.completeCiConnect.mockImplementationOnce(() => new Promise(() => {}))
  else
    api.completeCiConnect.mockResolvedValueOnce(
      (scenario === 'install'
        ? { status: 'installation_required', installation_url: 'https://github.com/apps/test/installations/new' }
        : { status: 'failed' }) as any,
    )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/settings/ci/callback']}>
          <Routes>
            <Route path="/settings/ci/callback" element={<CiConnectCallback />} />
            <Route path="/dashboard/ci/connects" element={<p>Connects destination</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    )
    if (scenario === 'retry') {
      const button = [...host.querySelectorAll('button')].find(
        (item) => item.textContent === 'Retry authorization status',
      )!
      expect(button).toBeDefined()
      await act(async () => button.click())
      expect(api.getCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id)
      expect(api.completeCiConnect).toHaveBeenCalledTimes(1)
      expect(host.textContent).toBe('Connects destination')
      expect(JSON.parse(sessionStorage.getItem('boxlite-organization-session') || 'null')).toEqual({
        userId: 'callback-user',
        organizationId: organization,
      })
    } else if (scenario === 'back') {
      await act(async () => host.querySelector<HTMLAnchorElement>('a')!.click())
      expect(api.cancelCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id)
      expect(sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
      expect(host.textContent).toBe('Connects destination')
    } else {
      expect(host.querySelector('[role=alert]')).not.toBeNull()
      if (scenario === 'install')
        expect(
          [...host.querySelectorAll('a')]
            .find((link) => link.textContent === 'Install GitHub App')
            ?.getAttribute('href'),
        ).toBe('https://github.com/apps/test/installations/new')
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    sessionStorage.clear()
  }
})
