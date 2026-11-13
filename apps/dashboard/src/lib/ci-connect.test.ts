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
  it.each(['connected', 'failed', 'transport'])(
    'keeps a newer attempt when an older completion ends: %s',
    async (status) => {
      const module = await import('./ci-connect')
      module.prepareCiRedirect(organization, attempt())
      window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'code', state }))
      module.captureCiCallback()
      let finish!: (value: any) => void, fail!: (error: Error) => void
      const api = {
        completeCiInstallation: vi.fn(),
        completeCiConnect: vi.fn(
          () =>
            new Promise<any>((resolve, reject) => {
              finish = resolve
              fail = reject
            }),
        ),
      }
      const pending = module.completeCiRedirect(api).catch(() => undefined)
      const next = {
        ...attempt(),
        id: organization,
        authorization_url: 'https://github.com/login/oauth/authorize?state=' + organization + '.' + 'B'.repeat(43),
      }
      module.prepareCiRedirect(organization, next)
      if (status === 'transport') fail(Error('connection lost'))
      else finish({ status })
      await pending
      expect(module.getCiConnectSession()?.attempt).toBe(organization)
    },
  )
  it('recovers a lost completion response by reading the attempt without reusing the OAuth code', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'code', state }))
    module.captureCiCallback()
    const api = {
      completeCiInstallation: vi.fn(),
      completeCiConnect: vi.fn().mockRejectedValue(Error('lost response')),
      getCiConnect: vi.fn().mockResolvedValue({ id, status: 'selection_required' }),
    }
    await expect(module.completeCiRedirect(api)).rejects.toThrow()
    expect(module.getCiConnectSession()?.attempt).toBe(id)
    await expect(module.completeCiRedirect(api)).resolves.toMatchObject({
      organization,
      result: { status: 'selection_required' },
    })
    expect(api.completeCiConnect).toHaveBeenCalledTimes(1)
    expect(api.getCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id)
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
    const api = { completeCiInstallation: vi.fn(), completeCiConnect: vi.fn(async () => ({ status: 'connected' })) }
    const first = module.completeCiRedirect(api),
      second = module.completeCiRedirect(api)
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ organization, result: { status: 'connected' } })
    expect(api.completeCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id, { code: 'private-code', state })
    expect(window.sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
  })
  it.each(['User', 'Organization'])('accepts the selected %s installation permissions page', async (type) => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    const address =
      'https://github.com/apps/test/installations/new/permissions?' +
      new URLSearchParams({ state, target_id: '789', target_type: type })
    expect(module.prepareCiInstallationRedirect(id, address)).toBe(address)
  })
  it.each([
    'target_id=0&target_type=Organization',
    'target_id=01&target_type=Organization',
    'target_id=9007199254740992&target_type=Organization',
    'target_id=1.5&target_type=Organization',
    'target_id=789&target_type=Enterprise',
    'target_type=Organization',
    'target_id=789',
    'target_id=789&target_id=456&target_type=Organization',
    'target_id=789&target_type=Organization&target_type=User',
    'target_id=789&target_type=Organization&redirect_uri=https://evil.test',
    'target_id=789&target_type=Organization&state=other',
  ])('rejects malformed installation target query: %s', async (query) => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    expect(() =>
      module.prepareCiInstallationRedirect(
        id,
        'https://github.com/apps/test/installations/new/permissions?state=' + state + '&' + query,
      ),
    ).toThrow('Invalid GitHub installation')
  })
  it('keeps the legacy accountless install route but rejects unrelated query fields', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    const address = 'https://github.com/apps/test/installations/new?state=' + state
    expect(module.prepareCiInstallationRedirect(id, address)).toBe(address)
    expect(() => module.prepareCiInstallationRedirect(id, address + '&redirect_uri=https://evil.test')).toThrow()
  })
  it('cannot reuse a callback after a reload loses its in-memory code', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'private-code', state }))
    module.captureCiCallback()
    vi.resetModules()
    const reloaded = await import('./ci-connect'),
      api = { completeCiInstallation: vi.fn(), completeCiConnect: vi.fn() }
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
      const api = { completeCiInstallation: vi.fn(), completeCiConnect: vi.fn() }
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
      completeCiInstallation: vi.fn(),
      completeCiConnect: vi.fn(async () => {
        throw Error('private-code private-token')
      }),
    }
    const failure = await module.completeCiRedirect(api).catch((error) => error)
    expect(failure.message).not.toContain('private-code')
    expect(failure.cause).toBeUndefined()
    expect(module.getCiConnectSession()?.attempt).toBe(id)
  })
  it('refuses an outside authorize URL before writing routing metadata', async () => {
    const module = await import('./ci-connect')
    expect(() =>
      module.prepareCiRedirect(organization, { ...attempt(), authorization_url: 'https://evil.test/login' }),
    ).toThrow('Invalid GitHub authorization')
    expect(window.sessionStorage.length).toBe(0)
  })
  it('keeps routing metadata for account selection and processes the installation phase once', async () => {
    const module = await import('./ci-connect')
    module.prepareCiRedirect(organization, attempt())
    window.history.replaceState({}, '', '/settings/ci/callback?' + new URLSearchParams({ code: 'private-code', state }))
    module.captureCiCallback()
    module.captureCiCallback()
    const api = {
      completeCiConnect: vi.fn(async () => ({ status: 'selection_required' })),
      completeCiInstallation: vi.fn(async () => ({ status: 'connected' })),
    }
    await expect(module.completeCiRedirect(api)).resolves.toMatchObject({ result: { status: 'selection_required' } })
    expect(window.sessionStorage.getItem('boxlite.ci.connect')).not.toBeNull()
    window.history.replaceState(
      {},
      '',
      '/settings/ci/callback?' + new URLSearchParams({ installation_id: '123', setup_action: 'install', state }),
    )
    module.captureCiCallback()
    const first = module.completeCiRedirect(api),
      second = module.completeCiRedirect(api)
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ result: { status: 'connected' } })
    expect(api.completeCiConnect).toHaveBeenCalledTimes(1)
    expect(api.completeCiInstallation).toHaveBeenCalledExactlyOnceWith(organization, id, {
      installation_id: 123,
      state,
    })
    expect(window.location.search).toBe('')
    expect(window.sessionStorage.length).toBe(0)
  })
})

it('resumes a scrubbed callback without exchanging a code a second time', async () => {
  const module = await import('./ci-connect')
  const organization = '12345678-1234-4234-8234-123456789def',
    id = '12345678-1234-4234-8234-123456789abc'
  module.prepareCiRedirect(organization, {
    id,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    authorization_url: 'https://github.com/login/oauth/authorize?state=' + id + '.' + 'A'.repeat(43),
  })
  const api = {
    completeCiConnect: vi.fn(),
    completeCiInstallation: vi.fn(),
    getCiConnect: vi.fn(async () => ({ id, status: 'selection_required' })),
  }
  await expect(module.completeCiRedirect(api)).resolves.toMatchObject({
    organization,
    result: { status: 'selection_required' },
  })
  expect(api.getCiConnect).toHaveBeenCalledExactlyOnceWith(organization, id)
  expect(api.completeCiConnect).not.toHaveBeenCalled()
  expect(api.completeCiInstallation).not.toHaveBeenCalled()
})
