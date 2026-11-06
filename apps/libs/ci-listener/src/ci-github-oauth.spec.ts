/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { CiGitHubOAuth } from './ci-github-oauth'
import { CiGitHubApp } from './ci-gh-app'

describe('CI identity OAuth and per-App installation lookup', () => {
  const original = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const client = new CiGitHubOAuth({
    clientId: 'identity-client',
    clientSecret: () => 'private-identity-secret',
    dashboardUrl: 'https://console.test',
  })
  const app = new CiGitHubApp({
    clientId: 'org-client',
    accountType: 'Organization',
    slug: 'org-ci',
    privateKey: () => keys.privateKey,
  })
  const account = { accountId: 7, accountLogin: 'team', accountType: 'Organization' as const }
  afterEach(() => {
    global.fetch = original
  })
  it('requests only identity/organization reads and forces account selection only when requested', () => {
    const normal = new URL(client.authorizeWeb('state', 'A'.repeat(43))),
      switched = new URL(client.authorizeWeb('state', 'A'.repeat(43), true))
    expect(normal.searchParams.get('scope')).toBe('read:user read:org')
    expect(normal.searchParams.has('prompt')).toBe(false)
    expect(switched.searchParams.get('prompt')).toBe('select_account')
    expect(switched.searchParams.get('client_id')).toBe('identity-client')
    expect(switched.href).not.toContain('private-identity-secret')
    expect(() => JSON.stringify(client)).toThrow('cannot be serialized')
  })
  it.each(['read:org read:user', 'read:org', 'read:user read:org repo', 'user read:org', '', null])(
    'validates granted scope boundary: %s',
    async (scope) => {
      global.fetch = jest.fn(async (_url, options) => {
        const body = JSON.parse(String(options!.body))
        expect(body.client_id).toBe('identity-client')
        expect(body.code_verifier).toBe('B'.repeat(43))
        expect(options!.redirect).toBe('error')
        return new Response(JSON.stringify({ access_token: 'private-user-token', scope, token_type: 'bearer' }))
      }) as typeof fetch
      if (scope === 'read:org read:user')
        expect(await client.exchangeWeb('code', 'B'.repeat(43))).toBe('private-user-token')
      else await expect(client.exchangeWeb('code', 'B'.repeat(43))).rejects.toThrow('requires only')
    },
  )
  it.each(['unapproved OAuth', 'missing SAML'])(
    'keeps discovery authorization-limited for %s, and a fresh grant reveals the organization',
    async (_reason) => {
      let granted = false
      global.fetch = jest.fn(async (address, options) => {
        expect((options!.headers as any).Authorization).toBe('Bearer identity-token')
        const path = new URL(String(address)).pathname
        if (path === '/user') return new Response(JSON.stringify({ id: 1, login: 'alice', type: 'User' }))
        expect(path).toBe('/user/memberships/orgs')
        return new Response(
          JSON.stringify(
            granted
              ? [
                  { organization: { id: 7, login: 'team' }, state: 'active', role: 'admin' },
                  { organization: { id: 8, login: 'member-team' }, state: 'active', role: 'member' },
                  { organization: { id: 9, login: 'pending-team' }, state: 'pending', role: 'admin' },
                ]
              : [],
          ),
        )
      }) as typeof fetch
      expect((await client.ownedAccounts('identity-token')).accounts).toHaveLength(1)
      granted = true
      expect((await client.ownedAccounts('identity-token')).accounts).toEqual([
        { accountId: 1, accountLogin: 'alice', accountType: 'User' },
        account,
      ])
    },
  )
  it('does not turn an organization-access denial into an empty successful inventory', async () => {
    global.fetch = jest.fn(async (address) =>
      new URL(String(address)).pathname === '/user'
        ? new Response(JSON.stringify({ id: 1, login: 'alice', type: 'User' }))
        : new Response('{}', { status: 403 }),
    ) as typeof fetch
    await expect(client.ownedAccounts('identity-token')).rejects.toThrow('review OAuth organization access and SSO')
  })
  it.each([404, 403, 500])('only treats a real installation 404 as uninstalled: %s', async (status) => {
    global.fetch = jest.fn(async () => new Response('{}', { status })) as typeof fetch
    if (status === 404) expect(await app.installationFor(account)).toBeNull()
    else await expect(app.installationFor(account)).rejects.toThrow('lookup failed')
  })
  it.each(['valid', 'wrong-account', 'wrong-type', 'suspended', 'missing-permission'])(
    'checks target App JWT and installation metadata: %s',
    async (scenario) => {
      global.fetch = jest.fn(async (address, options) => {
        expect(String(address)).toBe('https://api.github.com/orgs/team/installation')
        const parts = (options!.headers as any).Authorization.slice(7).split('.')
        expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss).toBe('org-client')
        expect(
          verify(
            'RSA-SHA256',
            Buffer.from(parts[0] + '.' + parts[1]),
            keys.publicKey,
            Buffer.from(parts[2], 'base64url'),
          ),
        ).toBe(true)
        return new Response(
          JSON.stringify({
            id: 321,
            account: {
              id: scenario === 'wrong-account' ? 8 : 7,
              login: 'team',
              type: scenario === 'wrong-type' ? 'User' : 'Organization',
            },
            suspended_at: scenario === 'suspended' ? '2026-01-01' : null,
            permissions: { organization_self_hosted_runners: scenario === 'missing-permission' ? 'read' : 'write' },
          }),
        )
      }) as typeof fetch
      if (scenario === 'valid') expect(await app.installationFor(account)).toEqual({ ...account, installationId: 321 })
      else await expect(app.installationFor(account)).rejects.toThrow('denied')
    },
  )
})
