// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LandingPage from '../LandingPage'
import { markJustLoggedOut } from '@/lib/auth-session'

const auth = vi.hoisted(() => ({
  signinRedirect: vi.fn(),
  removeUser: vi.fn(),
  isAuthenticated: false,
  isLoading: false,
  error: undefined as undefined | { innerError: { error: string } },
  user: undefined as undefined | { profile: { sub: string } },
  activeNavigator: undefined as string | undefined,
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  sessionStorage.clear()
  auth.activeNavigator = undefined
  auth.user = undefined
  auth.isLoading = false
  auth.isAuthenticated = false
  auth.error = undefined
  auth.signinRedirect.mockReset().mockResolvedValue(undefined)
  auth.removeUser.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const mount = async (strict = false, path = '/') => {
  const page = (
    <MemoryRouter initialEntries={[path]}>
      <LandingPage />
    </MemoryRouter>
  )
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page))
}
const click = async () => {
  await act(async () => container.querySelector('button')!.click())
}

describe('account entry regression', () => {
  it('keeps explicit logout manual through StrictMode and a fresh mount', async () => {
    markJustLoggedOut()
    await mount(true)
    expect(auth.signinRedirect).not.toHaveBeenCalled()
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    expect(auth.signinRedirect).not.toHaveBeenCalled()
    expect(container.querySelector('button')).not.toBeNull()
  })
  it('replaces pending actions with loading and prevents duplicate requests', async () => {
    markJustLoggedOut()
    auth.signinRedirect.mockReturnValue(new Promise(() => undefined))
    await mount()
    await click()
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Loading')
    expect(container.textContent).not.toContain('Opening sign-in')
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1)
  })
  it('allows retry after the OIDC wrapper returns null on failure', async () => {
    markJustLoggedOut()
    auth.signinRedirect.mockResolvedValue(null)
    await mount()
    await click()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await click()
    expect(auth.signinRedirect).toHaveBeenCalledTimes(2)
  })
})

describe('account entry refinement', () => {
  it('allows normal sign-in without forcing account selection', async () => {
    markJustLoggedOut()
    await mount()
    await click()
    expect(auth.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: '/dashboard', visit: expect.objectContaining({ visit_id: expect.any(String) }) },
    })
  })
  it('requests account selection only through explicit account switching', async () => {
    markJustLoggedOut()
    await mount()
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Use another account')!
    await act(async () => button.click())
    expect(auth.signinRedirect).toHaveBeenCalledWith({
      prompt: 'login',
      state: { returnTo: '/dashboard', visit: expect.objectContaining({ visit_id: expect.any(String) }) },
    })
  })
  it('returns silently to manual entry after cancellation', async () => {
    markJustLoggedOut()
    auth.error = { innerError: { error: 'access_denied' } }
    await mount()
    expect(container.textContent).not.toContain('cancelled')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(auth.signinRedirect).not.toHaveBeenCalled()
  })
})

describe('account entry recovery coverage', () => {
  it('preserves the full destination when recovering from an authentication error', async () => {
    const destination = '/dashboard/user/invitations?id=inv-123#accept'
    auth.error = { innerError: { error: 'login_required' } }
    await mount(false, destination)
    expect(auth.signinRedirect).not.toHaveBeenCalled()
    await click()
    expect(auth.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: destination, visit: expect.objectContaining({ visit_id: expect.any(String) }) },
    })
  })
  it('recovers when the redirect rejects and permits a retry', async () => {
    markJustLoggedOut()
    auth.signinRedirect.mockRejectedValueOnce(new Error('offline'))
    await mount()
    await click()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('button')!.disabled).toBe(false)
    await click()
    expect(auth.signinRedirect).toHaveBeenCalledTimes(2)
  })
  it('clears a stale identity before opening hosted authentication', async () => {
    markJustLoggedOut()
    auth.user = { profile: { sub: 'old-user' } }
    let removalsAtRedirect = 0
    auth.signinRedirect.mockImplementation(async () => {
      removalsAtRedirect = auth.removeUser.mock.calls.length
    })
    await mount()
    await click()
    expect(removalsAtRedirect).toBe(1)
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1)
  })
  it('keeps actions disabled while checking the session', async () => {
    markJustLoggedOut()
    auth.isLoading = true
    await mount()
    expect(container.textContent).toContain('Loading')
    expect(container.textContent).not.toContain('Checking session')
    expect(container.querySelector('button')).toBeNull()
    expect(auth.signinRedirect).not.toHaveBeenCalled()
  })
  it('explains unsupported mock authentication without redirecting', async () => {
    markJustLoggedOut()
    auth.error = { innerError: { error: 'mock_auth_unavailable' } }
    await mount()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('requires the real sign-in service')
    expect(auth.signinRedirect).not.toHaveBeenCalled()
  })
})

it('shows loading on the first automatic sign-in render, before effects run', () => {
  const html = renderToString(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  )
  expect(html).toContain('Loading')
  expect(html).not.toContain('Sign in to BoxLite')
})
it('keeps loading after a successful redirect request until document navigation', async () => {
  markJustLoggedOut()
  await mount()
  await click()
  expect(container.textContent).toContain('Loading')
  expect(container.querySelector('button')).toBeNull()
})
it('shows loading while the identity provider navigator is active', async () => {
  auth.activeNavigator = 'signinRedirect'
  await mount()
  expect(container.textContent).toContain('Loading')
  expect(container.querySelector('button')).toBeNull()
  expect(auth.signinRedirect).not.toHaveBeenCalled()
})

// Browser back can restore the document without remounting React.
it('restores manual entry from the back-forward cache after a successful redirect', async () => {
  markJustLoggedOut()
  await mount()
  await click()
  expect(container.textContent).toContain('Loading')
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  expect(container.textContent).toContain('Sign in to BoxLite')
  expect(auth.signinRedirect).toHaveBeenCalledTimes(1)
  await click()
  expect(auth.signinRedirect).toHaveBeenCalledTimes(2)
})
