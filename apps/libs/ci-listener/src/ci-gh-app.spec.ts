/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { CiGitHubApp } from './ci-gh-app'

describe('CI GitHub App credentials and admission roles', () => {
  const keys = [
    generateKeyPairSync('rsa', { modulusLength: 2048 }),
    generateKeyPairSync('rsa', { modulusLength: 2048 }),
  ]
  const original = global.fetch
  afterEach(() => {
    global.fetch = original
  })
  const web = (options = {}) =>
    new CiGitHubApp({
      clientId: 'app-client',
      slug: 'ci-test',
      privateKey: () => keys[0].privateKey,
      clientSecret: () => 'private-oauth-secret',
      dashboardUrl: 'https://console.test',
      ...options,
    })
  it('completes the legacy browser and Device Flow transport with bounded fixed destinations', async () => {
    const app = web()
    const auth = new URL(app.authorizeWeb('state', 'A'.repeat(43)))
    expect(auth.origin + auth.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(auth.searchParams.get('redirect_uri')).toBe('https://console.test/settings/ci/callback')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    const responses = [
      { access_token: 'user-token' },
      {
        device_code: 'device',
        user_code: 'USER',
        verification_uri: 'https://github.com/login/device',
        expires_in: 300,
        interval: 5,
      },
      { error: 'authorization_pending' },
    ]
    global.fetch = jest.fn(async (_url, options) => {
      expect(options?.redirect).toBe('error')
      expect(JSON.parse(String(options?.body)).client_id).toBe('app-client')
      return new Response(JSON.stringify(responses.shift()))
    }) as typeof fetch
    expect(await app.exchangeWeb('code', 'B'.repeat(43))).toBe('user-token')
    expect(await app.startDevice()).toMatchObject({ interval: 5 })
    expect(await app.pollDevice('device')).toMatchObject({ error: 'authorization_pending' })
  })
  it.each([
    { dashboardUrl: 'https://user:secret@console.test' },
    { dashboardUrl: 'https://console.test/path' },
    { dashboardUrl: 'https://console.test/?query' },
    { dashboardUrl: 'https://console.test/#fragment' },
    { dashboardUrl: 'http://external.test' },
    { dashboardUrl: '' },
    { clientSecret: () => '' },
    { clientSecret: () => 'app-client' },
    { slug: '' },
  ])('rejects invalid legacy browser configuration %p', (options) => {
    expect(() => web(options).authorizeWeb('state', 'A'.repeat(43))).toThrow()
  })
  it.each(['http://localhost', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'allows a local callback origin %s',
    (dashboardUrl) => {
      expect(web({ dashboardUrl }).webSettings().redirectUri).toBe(dashboardUrl + '/settings/ci/callback')
    },
  )
  it.each([{}, { access_token: '' }, { access_token: 'token', error: 'denied' }, { access_token: 123 }])(
    'rejects unsuccessful browser exchanges %p',
    async (body) => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify(body))) as typeof fetch
      await expect(web().exchangeWeb('code', 'B'.repeat(43))).rejects.toThrow()
    },
  )
  it.each([
    { interval: 0 },
    { interval: 61 },
    { expires_in: 0 },
    { verification_uri: 'https://evil.test' },
    { user_code: null },
    { device_code: null },
  ])('rejects malformed device grants %p', async (override) => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            device_code: 'device',
            user_code: 'USER',
            verification_uri: 'https://github.com/login/device',
            expires_in: 300,
            interval: 5,
            ...override,
          }),
        ),
    ) as typeof fetch
    await expect(web().startDevice()).rejects.toThrow('Invalid GitHub device')
  })
  it('sanitizes secret and transport failures and rejects invalid browser input before HTTP', async () => {
    global.fetch = jest.fn().mockRejectedValue(Error('private token'))
    await expect(web().exchangeWeb('', 'short')).rejects.toThrow('Invalid GitHub browser')
    expect(global.fetch).not.toHaveBeenCalled()
    await expect(web().startDevice()).rejects.toThrow('GitHub authorization request failed')
    expect(() =>
      web({
        webhookSecret: () => {
          throw Error('private')
        },
      }).secret(),
    ).toThrow('secret unavailable')
    expect(() => web({ webhookSecret: () => Buffer.alloc(1) }).secret()).toThrow('secret unavailable')
    await expect(
      web({ privateKey: () => keys[0].publicKey }).verifyUserInstallation('token', 'owner'),
    ).rejects.toThrow()
  })
  it.each([
    {},
    { total_count: -1, installations: [] },
    { total_count: 1, installations: null },
    { total_count: 1, installations: [] },
    { total_count: 0, installations: [{ id: 10, account: { id: 7, login: 'owner', type: 'User' } }] },
  ])('fails closed on incomplete installation inventories %p', async (inventory) => {
    global.fetch = jest.fn(
      async (input) =>
        new Response(JSON.stringify(new URL(String(input)).pathname === '/user' ? { id: 7 } : inventory)),
    ) as typeof fetch
    await expect(web().availableInstallations('token')).rejects.toThrow('inventory')
  })
  it.each([
    {},
    [],
    Array.from({ length: 101 }, (_, id) => ({
      organization: { id: id + 10, login: 'org' },
      state: 'active',
      role: 'admin',
    })),
  ])('validates organization membership inventory shape %p', async (memberships) => {
    const installation = { id: 10, account: { id: 7, login: 'owner', type: 'Organization' } }
    global.fetch = jest.fn(async (input) => {
      const path = new URL(String(input)).pathname
      return new Response(
        JSON.stringify(
          path === '/user'
            ? { id: 1 }
            : path === '/user/installations'
              ? { total_count: 1, installations: [installation] }
              : memberships,
        ),
      )
    }) as typeof fetch
    if (Array.isArray(memberships) && !memberships.length)
      expect(await web().availableInstallations('token')).toEqual([])
    else await expect(web().availableInstallations('token')).rejects.toThrow('membership inventory')
  })
  it.each(['', 'bad/name'])('rejects invalid App client identities %s', (clientId) => {
    expect(() => web({ clientId })).toThrow('Invalid GitHub App identity')
  })
  it.each(['User', 'Organization'] as const)(
    'rejects a mismatched account role before installation lookup: %s',
    (accountType) => {
      global.fetch = jest.fn()
      return expect(
        web({ accountType }).installationFor({
          accountId: 7,
          accountLogin: 'owner',
          accountType: accountType === 'User' ? 'Organization' : 'User',
        }),
      ).rejects.toThrow('does not match')
    },
  )
  it.each(['valid', 'denied-default', 'denied-http', 'upstream'])(
    'sorts verified installations and distinguishes authority denials from provider failures: %s',
    async (mode) => {
      const installations = [
        { id: 10, account: { id: 7, login: 'owner', type: 'User' } },
        { id: 11, account: { id: 8, login: 'zeta', type: 'Organization' } },
        { id: 12, account: { id: 9, login: 'alpha', type: 'Organization' } },
      ]
      global.fetch = jest.fn(async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/user') return new Response(JSON.stringify({ id: 7 }))
        if (path === '/user/installations') return new Response(JSON.stringify({ total_count: 3, installations }))
        if (path === '/user/memberships/orgs')
          return new Response(
            JSON.stringify(
              installations.slice(1).map((item) => ({ organization: item.account, state: 'active', role: 'admin' })),
            ),
          )
        if (mode === 'upstream') return new Response('{}', { status: 503 })
        const installation = installations.find((item) => path.endsWith('/' + item.id))!
        return new Response(
          JSON.stringify({
            ...installation,
            suspended_at: null,
            permissions: {
              administration: 'write',
              organization_self_hosted_runners: mode.startsWith('denied') ? 'read' : 'write',
            },
          }),
        )
      }) as typeof fetch
      const app = web(
        mode === 'denied-http'
          ? { error: (status: number, message: string) => Object.assign(Error(message), { getStatus: () => status }) }
          : {},
      )
      if (mode === 'upstream') await expect(app.availableInstallations('token')).rejects.toThrow('request failed')
      else
        expect((await app.availableInstallations('token')).map((item) => item.accountLogin)).toEqual(
          mode === 'valid' ? ['alpha', 'zeta', 'owner'] : ['owner'],
        )
    },
  )
  it('rejects invalid upstream identities and non-string legacy secrets', async () => {
    expect(() => web({ clientSecret: () => null }).webSettings()).toThrow('not configured')
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 0 }))) as typeof fetch
    await expect(web().availableInstallations('token')).rejects.toThrow('Invalid GitHub identity')
  })
  it('uses each App original signing key and webhook secret without exposing credentials', async () => {
    const apps = keys.map(
      (key, index) =>
        new CiGitHubApp({
          clientId: 'app-' + index,
          privateKey: () => key.privateKey,
          webhookSecret: () => Buffer.alloc(32, index + 1),
        }),
    )
    global.fetch = jest.fn(async (_input, options) => {
      const token = (options!.headers as Record<string, string>).Authorization.slice(7),
        parts = token.split('.')
      const issuer = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss,
        index = Number(issuer.slice(4))
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          keys[index].publicKey,
          Buffer.from(parts[2], 'base64url'),
        ),
      ).toBe(true)
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          keys[1 - index].publicKey,
          Buffer.from(parts[2], 'base64url'),
        ),
      ).toBe(false)
      return new Response(
        JSON.stringify({
          id: index + 1,
          account: { id: 7, login: 'owner', type: 'User' },
          suspended_at: null,
          permissions: { metadata: 'read' },
        }),
      )
    }) as typeof fetch
    await apps[0].appSource().installation(1)
    await apps[1].appSource().installation(2)
    expect(apps[0].secret()).not.toEqual(apps[1].secret())
    const borrowed = apps[0].secret()
    borrowed.fill(0)
    expect(apps[0].secret()).toEqual(Buffer.alloc(32, 1))
    expect(() => JSON.stringify(apps[0])).toThrow('cannot be serialized')
  })
  it.each(['User', 'Organization'] as const)('limits new connect to the %s App role', async (accountType) => {
    const app = new CiGitHubApp({ clientId: 'app', slug: 'example', privateKey: () => keys[0].privateKey, accountType })
    const otherType = accountType === 'User' ? 'Organization' : 'User'
    const installation = {
      id: 10,
      account: { id: 7, login: 'owner', type: otherType },
      suspended_at: null,
      permissions: { administration: 'write', organization_self_hosted_runners: 'write' },
    }
    global.fetch = jest.fn(async (input) => {
      const path = new URL(String(input)).pathname
      const value =
        path === '/user'
          ? { id: 7 }
          : path === '/user/installations'
            ? { total_count: 1, installations: [installation] }
            : path === '/user/memberships/orgs'
              ? [{ state: 'active', role: 'admin', organization: { id: 7, login: 'owner' } }]
              : installation
      return new Response(JSON.stringify(value))
    }) as typeof fetch
    expect(await app.availableInstallations('private-user-token')).toEqual([])
    await expect(app.verifyUserInstallation('private-user-token', 10)).rejects.toThrow('account type')
  })
})
