/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { createSign, generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UnauthorizedException, type INestApplication } from '@nestjs/common'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { PassportModule } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JwtStrategy } from '../auth/jwt.strategy'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxService } from '../box/services/box.service'
import { DomainService } from '../box/services/domain.service'
import { BoxliteDomainController } from './boxlite-domain.controller'

// Exercise the real Passport strategies and both controller guards over HTTP.
// Only credential/user storage, membership storage, Redis and domain persistence
// are fixtures; no guard or permission-policy decision is replaced.
describe('Domain acquisition authorization', () => {
  let app: INestApplication
  let jwks: Server
  let issuer: string
  let claim: jest.Mock
  let bindApp: jest.Mock
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const audience = 'domain-authorization-test'
  const organizationId = 'org-1'

  function jwt(userId: string, options: { expired?: boolean; wrongSignature?: boolean } = {}): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = [
      encode({ alg: 'RS256', kid: 'domain-auth-test' }),
      encode({
        sub: userId,
        email: `${userId}@example.test`,
        iss: issuer,
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + (options.expired ? -60 : 600),
      }),
    ].join('.')
    const signingKey = options.wrongSignature
      ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : keys.privateKey
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(signingKey).toString('base64url')}`
  }

  beforeAll(async () => {
    jwks = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'domain-auth-test', alg: 'RS256', use: 'sig' }],
        }),
      )
    })
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`

    const cache = new Map<string, string>()
    const redis = {
      get: async (key: string) => cache.get(key) ?? null,
      set: async (key: string, value: string) => {
        cache.set(key, value)
        return 'OK'
      },
      setex: async (key: string, _ttl: number, value: string) => {
        cache.set(key, value)
        return 'OK'
      },
    }
    const users = {
      findOne: async (userId: string) => ({
        id: userId,
        role: SystemRole.USER,
        name: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
      }),
    }
    const config = { get: (key: string) => (key === 'proxy.apiKey' ? 'domain-proxy-key' : 30) }
    const apiKeys = {
      getApiKeyByValue: async (token: string) => {
        if (!['domain-write-key', 'domain-read-key', 'domain-expired-key', 'app-write-key'].includes(token))
          throw new UnauthorizedException()
        return {
          organizationId,
          userId: 'owner',
          name: token,
          permissions: [
            token.startsWith('app-')
              ? OrganizationResourcePermission.WRITE_APPS
              : token === 'domain-read-key'
                ? OrganizationResourcePermission.READ_IMAGES
                : OrganizationResourcePermission.WRITE_BOXES,
          ],
          expiresAt: token === 'domain-expired-key' ? new Date(0) : undefined,
        }
      },
      updateLastUsedAt: jest.fn().mockResolvedValue(undefined),
    }
    claim = jest.fn().mockResolvedValue({ hostname: 'my-app.apps.test', url: 'https://my-app.apps.test', target: null })
    bindApp = jest.fn().mockResolvedValue({
      hostname: 'my-app.apps.test',
      url: 'https://my-app.apps.test',
      target: { type: 'app', app: 'shop', environment: 'env-main' },
    })
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ session: false })],
      controllers: [BoxliteDomainController],
      providers: [
        {
          provide: DomainService,
          useValue: {
            claim,
            bindApp,
            owned: jest.fn().mockResolvedValue({ target: null }),
            listHeld: jest.fn().mockResolvedValue({
              domains: [],
              limit: 1,
              used: 0,
              remaining: 1,
              minLength: 5,
              domainSuffix: 'apps.test',
            }),
          },
        },
        { provide: BoxService, useValue: {} },
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: async (org: string, userId: string) => {
              if (org !== organizationId || userId === 'outsider') return null
              return {
                organizationId: org,
                userId,
                role: userId === 'owner' ? OrganizationMemberRole.OWNER : OrganizationMemberRole.MEMBER,
                assignedRoles: [
                  {
                    permissions: [
                      userId === 'app-writer'
                        ? OrganizationResourcePermission.WRITE_APPS
                        : userId === 'app-reader'
                          ? OrganizationResourcePermission.READ_APPS
                          : userId === 'writer'
                            ? OrganizationResourcePermission.WRITE_BOXES
                            : OrganizationResourcePermission.READ_IMAGES,
                    ],
                  },
                ],
              }
            },
          },
        },
        {
          provide: ApiKeyStrategy,
          useFactory: () =>
            new ApiKeyStrategy(
              redis as never,
              apiKeys as never,
              users as never,
              config as never,
              { findByApiKey: async () => null } as never,
              { findOneByProxyApiKey: async () => null } as never,
            ),
        },
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              { issuer, audience, jwksUri: `${issuer}/jwks` },
              users as never,
              config as never,
              { recordFirstUse: async () => undefined } as never,
            ),
        },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await app?.close()
    if (jwks?.listening)
      await new Promise<void>((resolve, reject) => jwks.close((error) => (error ? reject(error) : resolve())))
  })
  beforeEach(() => {
    claim.mockClear()
    bindApp.mockClear()
  })

  async function request(
    path: string,
    token?: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api${path}`, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: options.method === 'GET' ? undefined : JSON.stringify(options.body ?? { name: 'my-app' }),
    })
  }

  it('allows a signed JWT member with Box write permission and a JWT owner', async () => {
    for (const userId of ['writer', 'owner']) {
      const response = await request('/v1/org-1/domains', jwt(userId))
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ hostname: 'my-app.apps.test', target: null })
    }
    expect(claim.mock.calls).toEqual([
      [organizationId, 'my-app'],
      [organizationId, 'my-app'],
    ])
  })

  it('allows a scoped write API key on canonical, explicit and legacy organization paths', async () => {
    for (const prefix of ['', '/org-1', '/default']) {
      expect((await request(`/v1${prefix}/domains`, 'domain-write-key')).status).toBe(201)
    }
    expect(claim.mock.calls).toEqual(Array.from({ length: 3 }, () => [organizationId, 'my-app']))
  })

  it('rejects missing, unknown, expired and wrongly signed credentials before acquisition', async () => {
    for (const token of [
      undefined,
      'unknown-key',
      'domain-expired-key',
      jwt('writer', { expired: true }),
      jwt('writer', { wrongSignature: true }),
    ]) {
      expect((await request('/v1/org-1/domains', token)).status).toBe(401)
    }
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects read-only members, read-only owner keys, nonmembers and machine credentials before acquisition', async () => {
    for (const token of [jwt('reader'), 'domain-read-key', jwt('outsider'), 'domain-proxy-key']) {
      expect((await request('/v1/org-1/domains', token)).status).toBe(403)
    }
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects a foreign organization for both scoped API keys and signed JWT users', async () => {
    for (const token of ['domain-write-key', jwt('writer')]) {
      expect((await request('/v1/org-other/domains', token)).status).toBe(403)
    }
    expect(claim).not.toHaveBeenCalled()
  })
  it('allows App writers to claim and bind App targets but not Box targets', async () => {
    expect((await request('/v1/org-1/domains', jwt('app-writer'))).status).toBe(201)
    expect((await request('/v1/org-1/domains', 'app-write-key')).status).toBe(201)
    const input = { method: 'PUT', body: { type: 'app', app: 'shop', environment: 'staging' } }
    expect((await request('/v1/org-1/domains/my-app.apps.test/target', jwt('app-writer'), input)).status).toBe(200)
    expect(bindApp).toHaveBeenCalledWith('org-1', 'shop', 'staging', 'my-app.apps.test')
    expect((await request('/v1/org-1/domains/my-app.apps.test/target', jwt('writer'), input)).status).toBe(403)
    expect(
      (
        await request('/v1/org-1/domains/my-app.apps.test/target', jwt('app-writer'), {
          method: 'PUT',
          body: { type: 'box', box: 'web', port: 3000 },
        })
      ).status,
    ).toBe(403)
    expect(bindApp).toHaveBeenCalledTimes(1)
  })

  it('allows an App reader to list domains but not claim them', async () => {
    expect((await request('/v1/org-1/domains', jwt('app-reader'), { method: 'GET' })).status).toBe(200)
    expect((await request('/v1/org-1/domains', jwt('app-reader'))).status).toBe(403)
    expect(claim).not.toHaveBeenCalled()
  })
})
