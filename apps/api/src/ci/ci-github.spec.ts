/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { CiGitHubApp, CiInstallationRequired } from '@boxlite-ai/ci-listener'

describe('CI connect GitHub authority', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let service: CiGitHubApp
  const original = global.fetch
  beforeAll(() => {
    service = new CiGitHubApp({ clientId: 'app-client', slug: 'example', privateKey: () => keys.privateKey })
  })
  afterEach(() => {
    global.fetch = original
  })
  it.each([
    'personal',
    'organization',
    'wrong-personal-user',
    'member',
    'pending-owner',
    'wrong-membership-org',
    'missing-installation',
    'wrong-app-installation',
    'suspended',
    'permission-denied',
    'page-failure',
    'duplicate-installation',
  ])('checks %s at GitHub identity and installation boundaries', async (scenario) => {
    const organization = ['organization', 'member', 'pending-owner', 'wrong-membership-org'].includes(scenario)
    const account = { id: 456, login: 'alice', type: organization ? 'Organization' : 'User' }
    const installation = {
      id: 123,
      account,
      suspended_at: null,
      permissions: { administration: 'write', organization_self_hosted_runners: 'write' },
    }
    global.fetch = jest.fn(async (address, options) => {
      const url = new URL(String(address))
      expect(options?.redirect).toBe('error')
      const auth = (options?.headers as Record<string, string>).Authorization
      let body: any
      switch (url.pathname) {
        case '/user':
          expect(auth).toBe('Bearer user-token')
          body = { id: scenario === 'wrong-personal-user' ? 999 : 456 }
          break
        case '/user/installations':
          expect(auth).toBe('Bearer user-token')
          if (scenario === 'missing-installation') body = { total_count: 0, installations: [] }
          else if (scenario === 'duplicate-installation')
            body = { total_count: 2, installations: [installation, installation] }
          else if (scenario === 'page-failure' && url.searchParams.get('page') === '2')
            return new Response('{}', { status: 503 })
          else body = { total_count: scenario === 'page-failure' ? 2 : 1, installations: [installation] }
          break
        case '/app/installations/123': {
          const jwt = auth.substring('Bearer '.length).split('.')
          expect(JSON.parse(Buffer.from(jwt[1], 'base64url').toString()).iss).toBe('app-client')
          expect(
            verify('RSA-SHA256', Buffer.from(jwt[0] + '.' + jwt[1]), keys.publicKey, Buffer.from(jwt[2], 'base64url')),
          ).toBe(true)
          body = structuredClone(installation)
          if (scenario === 'wrong-app-installation') body.id = 124
          if (scenario === 'suspended') body.suspended_at = '2026-01-01'
          if (scenario === 'permission-denied') body.permissions.administration = 'read'
          break
        }
        case '/user/memberships/orgs':
          expect(auth).toBe('Bearer user-token')
          expect(url.searchParams.get('state')).toBe('active')
          body = [
            {
              state: scenario === 'pending-owner' ? 'pending' : 'active',
              role: scenario === 'member' ? 'member' : 'admin',
              organization: { id: scenario === 'wrong-membership-org' ? 999 : 456, login: 'alice' },
            },
          ]
          break
        default:
          throw new Error('unexpected route')
      }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    if (['personal', 'organization'].includes(scenario)) {
      expect(await service.verifyUserInstallation('user-token', 'alice')).toMatchObject({
        installationId: 123,
        accountId: 456,
        accountType: account.type,
      })
    } else if (scenario === 'missing-installation') {
      await expect(service.verifyUserInstallation('user-token', 'alice')).rejects.toBeInstanceOf(CiInstallationRequired)
    } else await expect(service.verifyUserInstallation('user-token', 'alice')).rejects.toThrow()
  })
  it('lists owned personal and organization installations without Members permission, then rechecks selection', async () => {
    const installations = [
      { id: 123, account: { id: 456, login: 'alice', type: 'User' }, permissions: { administration: 'write' } },
      {
        id: 124,
        account: { id: 789, login: 'team', type: 'Organization' },
        permissions: { organization_self_hosted_runners: 'write' },
      },
      { id: 125, account: { id: 999, login: 'other', type: 'User' }, permissions: { administration: 'write' } },
      {
        id: 126,
        account: { id: 790, login: 'members', type: 'Organization' },
        permissions: { organization_self_hosted_runners: 'write' },
      },
    ].map((item) => ({ ...item, suspended_at: null }))
    let owner = true
    const visited: string[] = []
    global.fetch = jest.fn(async (address) => {
      const url = new URL(String(address))
      visited.push(url.pathname)
      let body: unknown
      if (url.pathname === '/user') body = { id: 456 }
      else if (url.pathname === '/user/installations') body = { total_count: 4, installations }
      else if (url.pathname === '/user/memberships/orgs')
        body = [
          { state: 'active', role: owner ? 'admin' : 'member', organization: { id: 789, login: 'team' } },
          { state: 'active', role: 'member', organization: { id: 790, login: 'members' } },
        ]
      else body = installations.find((item) => url.pathname === '/app/installations/' + item.id)
      if (!body) return new Response('{}', { status: 403 })
      return new Response(JSON.stringify(body))
    }) as typeof fetch
    expect(await service.availableInstallations('user-token')).toEqual([
      { installationId: 124, accountId: 789, accountLogin: 'team', accountType: 'Organization' },
      { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' },
    ])
    expect(visited).not.toContain('/user/memberships/orgs/team')
    expect(visited).not.toContain('/app/installations/125')
    expect(visited).not.toContain('/app/installations/126')
    owner = false
    await expect(service.verifyUserInstallation('user-token', 124)).rejects.toThrow('owner required')
  })
  it.each(['owner-on-second-page', 'failed-later-page', 'duplicate-membership'])(
    'requires complete organization membership enumeration: %s',
    async (scenario) => {
      const installation = {
        id: 123,
        account: { id: 456, login: 'alice', type: 'Organization' },
        suspended_at: null,
        permissions: { organization_self_hosted_runners: 'write' },
      }
      global.fetch = jest.fn(async (address) => {
        const url = new URL(String(address))
        let body: unknown
        if (url.pathname === '/user') body = { id: 999 }
        else if (url.pathname === '/user/installations') body = { total_count: 1, installations: [installation] }
        else if (url.pathname === '/app/installations/123') body = installation
        else if (url.pathname === '/user/memberships/orgs') {
          if (url.searchParams.get('page') === '1')
            body = Array.from({ length: 100 }, (_, index) => ({
              state: 'active',
              role: 'admin',
              organization: { id: 1000 + index, login: 'team-' + index },
            }))
          else if (scenario === 'failed-later-page') return new Response('{}', { status: 503 })
          else
            body = [
              {
                state: 'active',
                role: 'admin',
                organization: {
                  id: scenario === 'duplicate-membership' ? 1000 : 456,
                  login: 'alice',
                },
              },
            ]
        } else return new Response('{}', { status: 403 })
        return new Response(JSON.stringify(body))
      }) as typeof fetch
      if (scenario === 'owner-on-second-page')
        await expect(service.verifyUserInstallation('user-token', 'alice')).resolves.toMatchObject({
          accountType: 'Organization',
        })
      else await expect(service.verifyUserInstallation('user-token', 'alice')).rejects.toThrow()
    },
  )
  it('uses the configured private App key for the shared runtime source', async () => {
    global.fetch = jest.fn(async (address, options) => {
      expect(String(address)).toBe('https://api.github.com/app/installations/123')
      const auth = (options?.headers as Record<string, string>).Authorization
      const jwt = auth.substring('Bearer '.length).split('.')
      expect(JSON.parse(Buffer.from(jwt[1], 'base64url').toString()).iss).toBe('app-client')
      expect(
        verify('RSA-SHA256', Buffer.from(jwt[0] + '.' + jwt[1]), keys.publicKey, Buffer.from(jwt[2], 'base64url')),
      ).toBe(true)
      return new Response(
        JSON.stringify({
          id: 123,
          account: { id: 456, login: 'alice', type: 'User' },
          permissions: { metadata: 'read' },
          suspended_at: null,
        }),
        { status: 200 },
      )
    }) as typeof fetch
    expect(await service.appSource().installation(123)).toMatchObject({
      id: 123,
      account: { id: 456, login: 'alice', type: 'User' },
    })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
  it('accepts only the official device verification URL and never forwards a client secret', async () => {
    global.fetch = jest.fn(async (_url, options) => {
      const sent = JSON.parse(String(options?.body))
      expect(sent).toEqual({ client_id: 'app-client' })
      return new Response(
        JSON.stringify({
          device_code: 'private-device',
          user_code: 'USER-CODE',
          verification_uri: 'https://evil.test/login',
          interval: 5,
          expires_in: 900,
        }),
      )
    }) as typeof fetch
    await expect(service.startDevice()).rejects.toThrow('Invalid GitHub device')
  })
  it('returns public App settings without the configured PEM', () => {
    expect(service.settings()).toEqual({
      clientId: 'app-client',
      installationUrl: 'https://github.com/apps/example/installations/new',
    })
  })
  it.each([
    '',
    'MALFORMED-CONFIDENTIAL-APP-KEY',
    'x'.repeat(65537),
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  ])('rejects an unusable secret value before sending GitHub credentials', async (value) => {
    global.fetch = jest.fn() as typeof fetch
    const invalid = new CiGitHubApp({
      clientId: 'app-client',
      slug: 'example',
      privateKey: () => {
        if (Buffer.byteLength(value) > 65536) throw Error('Invalid private key size')
        return createPrivateKey(value)
      },
    })
    const error = await (async () => invalid.appSource().installation(123))().catch((error) => error)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(error.status).toBe(503)
    if (value) expect(JSON.stringify(error)).not.toContain(value)
  })
})
