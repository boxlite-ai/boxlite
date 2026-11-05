/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CiGitHubService } from './ci-github.service'

describe('CI browser GitHub transport', () => {
  const original = global.fetch
  const values = {
    'ci.githubClientId': 'app-client',
    'ci.githubAppSlug': 'test-app',
    'ci.githubPrivateKey': 'not-used-by-web-transport',
    'ci.githubClientSecret': 'private-test-oauth-client-secret',
    dashboardUrl: 'https://console.test',
  }
  const make = (overrides = {}) =>
    new CiGitHubService({ get: (key: string) => ({ ...values, ...overrides })[key] } as any).forType('User')
  afterEach(() => {
    global.fetch = original
  })
  it('uses a fixed GitHub authorize URL, explicit callback and S256 challenge without the verifier or secret', () => {
    const url = new URL(make().authorizeWeb('independent-state', 'A'.repeat(43)))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'app-client',
      redirect_uri: 'https://console.test/settings/ci/callback',
      state: 'independent-state',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
    })
    expect(url.href).not.toContain(values['ci.githubClientSecret'])
    expect(JSON.stringify(make().webSettings())).not.toContain(values['ci.githubClientSecret'])
  })
  it('exchanges only at the fixed token endpoint and returns only the user token', async () => {
    global.fetch = jest.fn(async (address, options) => {
      expect(String(address)).toBe('https://github.com/login/oauth/access_token')
      expect(options?.redirect).toBe('error')
      expect(options?.method).toBe('POST')
      expect(JSON.parse(String(options?.body))).toEqual({
        client_id: 'app-client',
        client_secret: values['ci.githubClientSecret'],
        code: 'test-code',
        code_verifier: 'B'.repeat(43),
        redirect_uri: 'https://console.test/settings/ci/callback',
      })
      return new Response(
        JSON.stringify({ access_token: 'private-user-token', refresh_token: 'discarded-refresh-token' }),
      )
    }) as typeof fetch
    expect(await make().exchangeWeb('test-code', 'B'.repeat(43))).toBe('private-user-token')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    '',
    'http://console.test',
    'https://user:pass@console.test',
    'https://console.test/path',
    'https://console.test?redirect=other',
    'https://console.test/#fragment',
    'javascript:alert(1)',
  ])('rejects an unsafe callback origin before any HTTP request: %s', (origin) => {
    global.fetch = jest.fn() as typeof fetch
    expect(() => make({ dashboardUrl: origin }).webSettings()).toThrow('callback is not configured')
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('allows an explicit localhost HTTP callback for local development', () => {
    expect(make({ dashboardUrl: 'http://127.0.0.1:3000' }).webSettings().redirectUri).toBe(
      'http://127.0.0.1:3000/settings/ci/callback',
    )
  })
  it('rejects a client secret with a trailing newline instead of sending the malformed value', () => {
    expect(() => make({ 'ci.githubClientSecret': values['ci.githubClientSecret'] + '\n' }).webSettings()).toThrow(
      'browser authorization is not configured',
    )
  })
  it('rejects missing client credentials and malformed exchanges without leaking response bodies', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ error: 'private-upstream-secret' }), { status: 400 }),
    ) as typeof fetch
    expect(() => make({ 'ci.githubClientSecret': undefined }).webSettings()).toThrow(
      'browser authorization is not configured',
    )
    await expect(make().exchangeWeb('', 'B'.repeat(43))).rejects.toThrow('Invalid GitHub browser authorization')
    expect(global.fetch).not.toHaveBeenCalled()
    const error = await make()
      .exchangeWeb('test-code', 'B'.repeat(43))
      .catch((error) => error)
    expect(error.getStatus()).toBe(502)
    expect(JSON.stringify(error.getResponse())).not.toContain('private-upstream-secret')
    expect(JSON.stringify(error.getResponse())).not.toContain(values['ci.githubClientSecret'])
  })
  it('selects Organization OAuth credentials without falling back to the Personal App', async () => {
    const config = {
      ...values,
      'ci.githubOrgClientId': 'organization-client',
      'ci.githubOrgAppSlug': 'organization-app',
      'ci.githubOrgPrivateKey': 'not-used-by-web-transport',
      'ci.githubOrgClientSecret': 'private-organization-oauth-secret',
    }
    const registry = new CiGitHubService({ get: (key: string) => config[key] } as any)
    global.fetch = jest.fn(async (address, options) => {
      const url = new URL(String(address))
      if (url.pathname === '/users/team')
        return new Response(JSON.stringify({ id: 7, login: 'team', type: 'Organization' }))
      expect(url.href).toBe('https://github.com/login/oauth/access_token')
      expect(JSON.parse(String(options?.body))).toMatchObject({
        client_id: 'organization-client',
        client_secret: config['ci.githubOrgClientSecret'],
      })
      return new Response(JSON.stringify({ access_token: 'private-org-user-token' }))
    }) as typeof fetch
    const app = await registry.forAccount('team')
    expect(app).toBe(registry.byClientId('organization-client'))
    expect(new URL(app.authorizeWeb('state', 'A'.repeat(43))).searchParams.get('client_id')).toBe('organization-client')
    expect(await app.exchangeWeb('code', 'A'.repeat(43))).toBe('private-org-user-token')
    expect(registry.byClientId('app-client')).not.toBe(app)
    expect(() => registry.byClientId('unknown')).toThrow('no longer configured')
  })
})
