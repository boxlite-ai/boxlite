// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('CI browser callback state', () => {
  const id = '12345678-1234-4234-8234-123456789abc',
    organization = '12345678-1234-4234-8234-123456789def'
  const state = id + '.' + 'A'.repeat(43)
  const attempt = () => ({
    id,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    installation_url: 'https://github.com/apps/test/installations/new',
    authorization_url: 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ state }),
  })
  beforeEach(() => {
    vi.resetModules()
    window.sessionStorage.clear()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it('scrubs the entire callback URL and keeps only routing metadata across the redirect', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    const stored = JSON.parse(window.sessionStorage.getItem('boxlite.ci.connect')!)
    expect(stored).toEqual({ attempt: id, organization, expires: expect.any(Number) })
    expect(window.localStorage.length).toBe(0)
    window.history.replaceState(
      {},
      '',
      '/settings/ci/callback?' +
        new URLSearchParams({ code: 'private-code', state, error_description: 'private-untrusted-error' }) +
        '#private-fragment',
    )
    module.captureCiCallback()
    expect(window.location.pathname).toBe('/settings/ci/callback')
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    const api = { completeCiConnect: vi.fn(async () => ({ status: 'connected' })) }
    const first = module.completeCiRedirect(api),
      second = module.completeCiRedirect(api)
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ organization, result: { status: 'connected' } })
    expect(api.completeCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id, { code: 'private-code', state })
    expect(window.sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
  })
  it('cannot reuse a callback after a reload loses its in-memory code', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'private-code', state }))
    module.captureCiCallback()
    vi.resetModules()
    const reloaded = await import('./ci-connect'),
      api = { completeCiConnect: vi.fn() }
    reloaded.captureCiCallback()
    await expect(reloaded.completeCiRedirect(api)).rejects.toThrow('Restart connect')
    expect(api.completeCiConnect).not.toHaveBeenCalled()
  })
  it.each(['missing', 'wrong-attempt', 'expired', 'duplicate-code', 'error'])(
    'rejects %s metadata or callbacks without submitting code',
    async (scenario) => {
      const module = await import('./ci-connect')
      if (scenario !== 'missing') module.prepareCiRedirect(organization, attempt())
      if (scenario === 'wrong-attempt')
        window.sessionStorage.setItem(
          'boxlite.ci.connect',
          JSON.stringify({ attempt: organization, organization, expires: Date.now() + 300000 }),
        )
      if (scenario === 'expired')
        window.sessionStorage.setItem(
          'boxlite.ci.connect',
          JSON.stringify({ attempt: id, organization, expires: Date.now() - 1 }),
        )
      const query = new URLSearchParams({ code: 'private-code', state })
      if (scenario === 'duplicate-code') query.append('code', 'other-code')
      if (scenario === 'error') query.set('error', 'access_denied')
      window.history.replaceState({}, '', '/settings/ci/callback?' + query)
      module.captureCiCallback()
      const api = { completeCiConnect: vi.fn() }
      await expect(module.completeCiRedirect(api)).rejects.toThrow('Restart connect')
      expect(window.location.search).toBe('')
      expect(api.completeCiConnect).not.toHaveBeenCalled()
    },
  )
  it('sanitizes an upstream exception that contains submitted code', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'private-code', state }))
    module.captureCiCallback()
    const api = {
      completeCiConnect: vi.fn(async () => {
        throw Error('private-code private-token')
      }),
    }
    const failure = await module.completeCiRedirect(api).catch((error) => error)
    expect(failure.message).not.toContain('private-code')
    expect(failure.cause).toBeUndefined()
    expect(window.sessionStorage.length).toBe(0)
  })
  it('refuses an outside authorize URL before writing routing metadata', async () => {
    const module = await import('./ci-connect')
    expect(() =>
      module.prepareCiRedirect(organization, { ...attempt(), authorization_url: 'https://evil.test/login' }),
    ).toThrow('Invalid GitHub authorization')
    expect(window.sessionStorage.length).toBe(0)
  })
})
