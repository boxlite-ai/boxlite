// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
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
  user: undefined,
  activeNavigator: undefined,
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  sessionStorage.clear()
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
const mount = async (strict = false) => {
  const page = (
    <MemoryRouter>
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
  it('disables the pending primary action and prevents duplicate requests', async () => {
    markJustLoggedOut()
    auth.signinRedirect.mockReturnValue(new Promise(() => undefined))
    await mount()
    await click()
    expect(container.querySelector('button')!.disabled).toBe(true)
    expect(container.textContent).toContain('Opening sign-in')
    await click()
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
    expect(auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard' } })
  })
  it('requests account selection only through explicit account switching', async () => {
    markJustLoggedOut()
    await mount()
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Use another account')!
    await act(async () => button.click())
    expect(auth.signinRedirect).toHaveBeenCalledWith({ prompt: 'login', state: { returnTo: '/dashboard' } })
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
