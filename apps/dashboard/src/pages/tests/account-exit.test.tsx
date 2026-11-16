// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Logout from '../Logout'
import { ApiProvider } from '@/providers/ApiProvider'
import { markJustLoggedOut } from '@/lib/auth-session'

const auth = vi.hoisted(() => ({
  user: { id_token: 'id-token-hint', access_token: 'old-token' } as
    | { id_token: string; access_token: string }
    | undefined,
  isAuthenticated: true,
  isLoading: false,
  error: undefined,
  activeNavigator: undefined,
  signoutRedirect: vi.fn(),
  signinRedirect: vi.fn(),
  removeUser: vi.fn(),
  stopSilentRenew: vi.fn(),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))
vi.mock('@/hooks/useConfig', () => {
  const config = { apiUrl: '/api' }
  return { useConfig: () => config }
})
vi.mock('@/api/apiClient', () => ({
  ApiClient: class {
    setAccessToken() {}
  },
}))
let root: Root
let container: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/')
  sessionStorage.clear()
  auth.user = { id_token: 'id-token-hint', access_token: 'old-token' }
  auth.isAuthenticated = true
  auth.removeUser.mockReset().mockResolvedValue(undefined)
  auth.signoutRedirect.mockReset().mockResolvedValue(undefined)
  auth.signinRedirect.mockReset().mockResolvedValue(undefined)
  auth.stopSilentRenew.mockReset()
  client = new QueryClient()
  client.setQueryData(['boxes'], ['account A box'])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
})
async function mount(path = '/logout', child = <Logout />) {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/logout" element={child} />
              <Route path="/dashboard/*" element={child} />
              <Route path="/" element={<div>Manual sign-in</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  )
}

describe('account exit regression', () => {
  it('clears the local identity and cached resources before provider logout, once in StrictMode', async () => {
    auth.signoutRedirect.mockImplementation(async () => {
      expect(auth.removeUser).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['boxes'])).toBeUndefined()
    })
    await mount()
    expect(auth.signoutRedirect).toHaveBeenCalledTimes(1)
    expect(auth.signoutRedirect).toHaveBeenCalledWith({ id_token_hint: 'id-token-hint' })
  })
  it('does not claim signed out or redirect when local clear fails', async () => {
    auth.removeUser.mockRejectedValue(new Error('storage blocked'))
    await mount()
    expect(auth.signoutRedirect).not.toHaveBeenCalled()
    expect(container.textContent).toContain('couldn’t clear your local session')
    expect(container.textContent).not.toContain('You’re signed out')
  })
  it('reports a swallowed provider logout failure after local clear', async () => {
    auth.signoutRedirect.mockResolvedValue(null)
    await mount()
    expect(container.textContent).toContain('You’re signed out of BoxLite')
    expect(container.textContent).toContain('your sign-in provider may still have an active session')
    expect(container.textContent).toContain('Sign in')
  })
  it('does not automatically sign in from a protected URL after explicit logout', async () => {
    markJustLoggedOut()
    auth.user = undefined
    auth.isAuthenticated = false
    await mount(
      '/dashboard/keys',
      <ApiProvider>
        <div>Protected data</div>
      </ApiProvider>,
    )
    expect(auth.signinRedirect).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Protected data')
  })
})

describe('account switch contract', () => {
  it('clears account data then requests choice, consumes the switch URL, and preserves returnTo', async () => {
    window.history.replaceState({}, '', '/logout?switch=1')
    await mount('/logout?switch=1&returnTo=%2Fdashboard%2Fkeys')
    expect(auth.removeUser).toHaveBeenCalledTimes(1)
    expect(auth.signoutRedirect).not.toHaveBeenCalled()
    expect(auth.signinRedirect).toHaveBeenCalledWith({
      prompt: 'login',
      state: { returnTo: '/dashboard/keys' },
    })
    expect(window.location.pathname + window.location.search).toBe('/')
    expect(client.getQueryData(['boxes'])).toBeUndefined()
  })
  it('retains automatic reauthentication for an unauthenticated protected route', async () => {
    auth.user = undefined
    auth.isAuthenticated = false
    await mount(
      '/dashboard/keys',
      <ApiProvider>
        <div>Protected data</div>
      </ApiProvider>,
    )
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1)
    expect(auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard/keys' } })
  })
})
