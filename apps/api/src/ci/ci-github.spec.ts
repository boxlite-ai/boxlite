/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { CiGitHubService, CiInstallationRequired } from './ci-github.service'

describe('CI connect GitHub authority', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let service: CiGitHubService
  const original = global.fetch
  beforeAll(() => {
    const config = {
      'ci.githubClientId': 'app-client',
      'ci.githubAppSlug': 'example',
      'ci.githubPrivateKey': keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    }
    service = new CiGitHubService({ get: (name: string) => config[name] } as any)
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
        case '/user/memberships/orgs/alice':
          expect(auth).toBe('Bearer user-token')
          body = {
            state: scenario === 'pending-owner' ? 'pending' : 'active',
            role: scenario === 'member' ? 'member' : 'admin',
            organization: { id: scenario === 'wrong-membership-org' ? 999 : 456 },
          }
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
    const config = { 'ci.githubClientId': 'app-client', 'ci.githubAppSlug': 'example', 'ci.githubPrivateKey': value }
    const invalid = new CiGitHubService({ get: (name: string) => config[name] } as any)
    const error = await (async () => invalid.appSource().installation(123))().catch((error) => error)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(error.getStatus()).toBe(503)
    if (value) expect(JSON.stringify(error.getResponse())).not.toContain(value)
  })
})
