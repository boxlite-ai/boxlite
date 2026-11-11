/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CiGitHubService } from './ci-github.service'
import { Logger } from '@nestjs/common'

describe('CI browser GitHub transport', () => {
  const original = global.fetch
  const values = {
    'ci.githubClientId': 'app-client',
    'ci.githubOAuthClientId': 'identity-client',
    'ci.githubOAuthClientSecret': 'private-identity-oauth-secret',
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
  it.each(['missing-app', 'same-app', 'missing-identity', 'overlapping-identity', 'changed-identity'])(
    'rejects invalid CI App registry configuration: %s',
    (scenario) => {
      const config = { ...values } as Record<string, string>
      if (scenario === 'missing-app') config['ci.githubClientId'] = ''
      if (scenario === 'same-app') config['ci.githubOrgClientId'] = config['ci.githubClientId']
      if (scenario === 'missing-identity') config['ci.githubOAuthClientId'] = ''
      if (scenario === 'overlapping-identity') config['ci.githubOAuthClientId'] = config['ci.githubClientId']
      const registry = new CiGitHubService({ get: (key: string) => config[key] } as any)
      if (scenario === 'changed-identity') {
        expect(registry.authorizationApp('app-client')).toBe(registry.forType('User'))
        expect(registry.authorizationApp('identity-client')).toBe(registry.identity())
      }
      if (scenario === 'changed-identity') {
        registry.identity()
        config['ci.githubOAuthClientId'] = 'changed-client'
      }
      expect(() => (scenario.endsWith('app') ? registry.forType('User') : registry.identity())).toThrow()
    },
  )
  it.each(['-account', 'a'.repeat(40), 'owner/repo'])(
    'rejects invalid account lookup before HTTP: %s',
    async (account) => {
      global.fetch = jest.fn()
      const registry = new CiGitHubService({ get: (key: string) => values[key] } as any)
      await expect(registry.forAccount(account)).rejects.toThrow('Invalid GitHub account')
      expect(global.fetch).not.toHaveBeenCalled()
    },
  )
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
    const lookupAuth: (string | null)[] = []
    global.fetch = jest.fn(async (address, options) => {
      const url = new URL(String(address))
      if (url.pathname === '/users/team') {
        lookupAuth.push(new Headers(options?.headers).get('authorization'))
        expect(url.search).toBe('')
        return new Response(JSON.stringify({ id: 7, login: 'team', type: 'Organization' }))
      }
      expect(url.href).toBe('https://github.com/login/oauth/access_token')
      expect(JSON.parse(String(options?.body))).toMatchObject({
        client_id: 'organization-client',
        client_secret: config['ci.githubOrgClientSecret'],
      })
      return new Response(JSON.stringify({ access_token: 'private-org-user-token' }))
    }) as typeof fetch
    const app = await registry.forAccount('team')
    expect(lookupAuth).toEqual([
      'Basic ' + Buffer.from('identity-client:private-identity-oauth-secret').toString('base64'),
    ])
    expect(app).toBe(registry.byClientId('organization-client'))
    expect(new URL(app.authorizeWeb('state', 'A'.repeat(43))).searchParams.get('client_id')).toBe('organization-client')
    expect(await app.exchangeWeb('code', 'A'.repeat(43))).toBe('private-org-user-token')
    expect(registry.byClientId('app-client')).not.toBe(app)
    expect(() => registry.byClientId('unknown')).toThrow('no longer configured')
  })
})

describe('CI dedicated identity registry', () => {
  const original = global.fetch
  afterEach(() => {
    global.fetch = original
  })
  it.each(['success', 'account-mismatch', 'upstream-failure', 'retirement-retry'])(
    'owns repository metadata authority, safe errors and shutdown cleanup: %s',
    async (scenario) => {
      const { generateKeyPairSync } = await import('node:crypto')
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      const config: Record<string, string> = {
        'ci.githubClientId': 'metadata-client',
        'ci.githubPrivateKey': key.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }
      const registry = new CiGitHubService({ get: (name: string) => config[name] } as any)
      let retirementFails = scenario === 'retirement-retry'
      const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
      global.fetch = jest.fn(async (input, options) => {
        const url = new URL(String(input))
        if (url.pathname === '/app/installations/11')
          return new Response(
            JSON.stringify({
              id: 11,
              account: { id: 7, login: 'owner', type: 'User' },
              suspended_at: null,
              permissions: { metadata: 'read' },
              repository_selection: 'selected',
            }),
          )
        if (url.pathname === '/app/installations/11/access_tokens') {
          expect(JSON.parse(String(options?.body))).toEqual({ permissions: { metadata: 'read' } })
          return new Response(
            JSON.stringify({
              token: 'private-metadata-token',
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: { metadata: 'read' },
            }),
            { status: 201 },
          )
        }
        if (url.pathname === '/installation/repositories') {
          expect(url.searchParams.get('page')).toBe('1')
          expect(url.searchParams.get('per_page')).toBe('25')
          return scenario === 'upstream-failure'
            ? new Response('private-upstream-body', { status: 503 })
            : new Response(
                JSON.stringify({
                  total_count: 1,
                  repositories: [{ id: 21, name: 'repo', private: true, owner: { id: 7, login: 'owner' } }],
                }),
              )
        }
        expect(url.pathname).toBe('/installation/token')
        expect(options?.method).toBe('DELETE')
        return retirementFails ? new Response('{}', { status: 503 }) : new Response(null, { status: 204 })
      }) as typeof fetch
      try {
        const page = registry.repositoryPage(
          'metadata-client',
          {
            installationId: 11,
            accountId: 7,
            accountLogin: 'owner',
            accountType: scenario === 'account-mismatch' ? 'Organization' : 'User',
          },
          1,
          25,
        )
        if (scenario === 'account-mismatch') {
          await expect(page).rejects.toThrow('Original CI App account type changed')
          expect(global.fetch).not.toHaveBeenCalled()
        } else if (scenario === 'upstream-failure') {
          const error = await page.catch((error) => error)
          expect(error.getStatus()).toBe(502)
          expect(error.getResponse().message).toBe('Unable to read GitHub repositories; retry later')
        } else {
          expect(await page).toMatchObject({ total: 1, repositories: [{ id: 21 }], next_page: null })
          if (retirementFails) {
            expect(warnings).toHaveBeenCalledWith('CI metadata credential retirement deferred')
            await expect(registry.onApplicationShutdown()).rejects.toThrow('retirement remains pending')
            retirementFails = false
          }
        }
        await expect(registry.onApplicationShutdown()).resolves.toBeUndefined()
      } finally {
        retirementFails = false
        await registry.onApplicationShutdown()
        warnings.mockRestore()
      }
    },
  )
  it('discovers an owned Organization CI installation without a Personal CI installation', async () => {
    const { generateKeyPairSync, verify } = await import('node:crypto')
    const personal = generateKeyPairSync('rsa', { modulusLength: 2048 }),
      org = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const values = {
      'ci.githubClientId': 'personal-ci',
      'ci.githubOrgClientId': 'organization-ci',
      'ci.githubAppSlug': 'personal-app',
      'ci.githubOrgAppSlug': 'org-app',
      'ci.githubPrivateKey': personal.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'ci.githubOrgPrivateKey': org.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'ci.githubOAuthClientId': 'identity-client',
      'ci.githubOAuthClientSecret': 'private-identity-secret',
      dashboardUrl: 'https://console.test',
    }
    const registry = new CiGitHubService({ get: (key: string) => values[key] } as any)
    const visited: string[] = []
    global.fetch = jest.fn(async (address, options) => {
      const path = new URL(String(address)).pathname
      visited.push(path)
      const auth = (options!.headers as Record<string, string>).Authorization
      if (path === '/user') {
        expect(auth).toBe('Bearer identity-token')
        return new Response(JSON.stringify({ id: 456, login: 'alice', type: 'User' }))
      }
      if (path === '/user/memberships/orgs')
        return new Response(
          JSON.stringify([{ state: 'active', role: 'admin', organization: { id: 789, login: 'team' } }]),
        )
      const jwt = auth.slice(7).split('.'),
        issuer = JSON.parse(Buffer.from(jwt[1], 'base64url').toString()).iss
      const key = path.startsWith('/users/') ? personal.publicKey : org.publicKey
      expect(issuer).toBe(path.startsWith('/users/') ? 'personal-ci' : 'organization-ci')
      expect(verify('RSA-SHA256', Buffer.from(jwt[0] + '.' + jwt[1]), key, Buffer.from(jwt[2], 'base64url'))).toBe(true)
      if (path === '/users/alice/installation') return new Response('{}', { status: 404 })
      expect(path).toBe('/orgs/team/installation')
      return new Response(
        JSON.stringify({
          id: 321,
          account: { id: 789, login: 'team', type: 'Organization' },
          suspended_at: null,
          permissions: { organization_self_hosted_runners: 'write' },
        }),
      )
    }) as typeof fetch
    expect((await registry.availableAccounts('identity-client', 'identity-token')).accounts).toEqual([
      { accountId: 456, accountLogin: 'alice', accountType: 'User', clientId: 'personal-ci', installationId: null },
      {
        accountId: 789,
        accountLogin: 'team',
        accountType: 'Organization',
        clientId: 'organization-ci',
        installationId: 321,
      },
    ])
    expect(visited).not.toContain('/user/installations')
    const authorization = new URL(registry.identity().authorizeWeb('state', 'A'.repeat(43), true))
    expect(authorization.searchParams.get('client_id')).toBe('identity-client')
    expect(authorization.searchParams.get('scope')).toBe('read:user read:org')
    expect(authorization.searchParams.get('prompt')).toBe('select_account')
    await expect(registry.availableAccounts('organization-ci', 'identity-token')).rejects.toThrow('Original identity')
  })
})
