// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSignInIntent, safeReturnTo } from '@/lib/auth-session'
import { readPreferredOrganization, readOrganizationSession, saveOrganizationSession } from '@/lib/organization-session'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})
describe('account storage recovery', () => {
  it('stays manual when session intent cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(getSignInIntent()).toEqual({ signedOut: false, returnTo: '/dashboard' })
    expect(readPreferredOrganization('user')).toBeNull()
  })
  it('keeps the active tab usable if optional preference persistence fails', () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('boxlite-preferred-organization:')) throw new Error('quota')
      original.call(this, key, value)
    })
    saveOrganizationSession('user', 'org')
    expect(readOrganizationSession('user')).toBe('org')
    expect(readPreferredOrganization('user')).toBeNull()
  })
  it('does not read a preference without an authenticated user', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem')
    expect(readPreferredOrganization(undefined)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects malformed URL input', () => {
    expect(safeReturnTo('https://[')).toBe('/dashboard')
  })
})
