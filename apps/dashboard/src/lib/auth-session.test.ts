// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountSwitchPath,
  completeSignIn,
  getSignInIntent,
  markJustLoggedOut,
  prepareSignIn,
  safeReturnTo,
} from './auth-session'
import { ORGANIZATION_SESSION_KEY } from './organization-session'

describe('account session intent', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())
  it('persists logout until an interactive sign-in completes', () => {
    sessionStorage.setItem(ORGANIZATION_SESSION_KEY, 'old organization')
    markJustLoggedOut('/dashboard/boxes')
    expect(getSignInIntent()?.signedOut).toBe(true)
    expect(getSignInIntent()?.signedOut).toBe(true)
    expect(sessionStorage.getItem(ORGANIZATION_SESSION_KEY)).toBeNull()
    completeSignIn()
    expect(getSignInIntent()).toBeNull()
  })
  it('preserves organization during renewal, clears it for interactive authentication', () => {
    sessionStorage.setItem(ORGANIZATION_SESSION_KEY, 'selected')
    completeSignIn()
    expect(sessionStorage.getItem(ORGANIZATION_SESSION_KEY)).toBe('selected')
    prepareSignIn('/dashboard/keys')
    expect(getSignInIntent()).toEqual({ signedOut: false, returnTo: '/dashboard/keys' })
    completeSignIn()
    expect(sessionStorage.getItem(ORGANIZATION_SESSION_KEY)).toBeNull()
  })
  it('reports blocked storage instead of claiming persistent logout', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => markJustLoggedOut()).toThrow('blocked')
  })
  it.each([
    'https://evil.test/dashboard',
    '//evil.test/dashboard',
    '/\\evil.test/dashboard',
    '/logout',
    '/dashboard/../logout',
    '/',
    '/dashboard\n/boxes',
  ])('rejects unsafe/action return destination %s', (value) => {
    expect(safeReturnTo(value)).toBe('/dashboard')
  })
  it('retains the GitHub recovery route without replaying callback credentials', () => {
    expect(safeReturnTo('/settings/ci/callback?code=secret&state=state#token')).toBe('/settings/ci/callback')
  })
  it('preserves a local deep link and encodes it in the switch entry', () => {
    const target = '/dashboard/boxes/box-1?tab=terminal#output'
    expect(safeReturnTo(target)).toBe(target)
    expect(safeReturnTo(window.location.origin + target)).toBe(target)
    expect(new URL(accountSwitchPath(target), window.location.origin).searchParams.get('returnTo')).toBe(target)
  })
})
