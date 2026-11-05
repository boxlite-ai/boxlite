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
