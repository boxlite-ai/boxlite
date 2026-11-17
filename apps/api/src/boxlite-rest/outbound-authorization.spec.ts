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
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { BoxliteBoxController } from './boxlite-box.controller'

// HTTP exercises the production Passport strategies and organization guards.
// Credential, membership, Redis and Box persistence are controlled fixtures.
describe('outbound policy HTTP authorization', () => {
  let app: INestApplication
  let jwks: Server
  let issuer: string
  let getPolicy: jest.Mock
  let getStatus: jest.Mock
  let setPolicy: jest.Mock
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const organizationId = 'org-1'
  const audience = 'outbound-authorization-test'

  function jwt(userId: string, expired = false): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = [
      encode({ alg: 'RS256', kid: 'outbound-auth-test' }),
      encode({
        sub: userId,
        email: `${userId}@example.test`,
        iss: issuer,
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 600),
      }),
    ].join('.')
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(keys.privateKey).toString('base64url')}`
  }

  beforeAll(async () => {
    jwks = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'outbound-auth-test', alg: 'RS256', use: 'sig' }],
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
      findOne: async (id: string) => ({
        id,
        role: SystemRole.USER,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
      }),
    }
    const config = { get: (key: string) => (key === 'proxy.apiKey' ? 'outbound-machine-key' : 30) }
    const apiKeys = {
      getApiKeyByValue: async (token: string) => {
        if (
          !['outbound-write-key', 'outbound-read-key', 'outbound-expired-key', 'outbound-outsider-key'].includes(token)
        )
          throw new UnauthorizedException()
        return {
          organizationId,
          userId: token === 'outbound-outsider-key' ? 'outsider' : 'owner',
          name: token,
          permissions: token === 'outbound-read-key' ? [] : [OrganizationResourcePermission.WRITE_BOXES],
          expiresAt: token === 'outbound-expired-key' ? new Date(0) : undefined,
        }
      },
      updateLastUsedAt: jest.fn().mockResolvedValue(undefined),
    }
    getPolicy = jest.fn().mockResolvedValue({ revision: 'rev-a', policy: { mode: 'enabled', allow_net: [] } })
    getStatus = jest.fn().mockResolvedValue({ application_state: 'pending', pending_revision: 'rev-b' })
    setPolicy = jest.fn().mockResolvedValue({
      outboundEnabled: false,
      outboundAllowNet: null,
      outboundControl: { version: 1, revision: 'rev-b' },
    })
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ session: false })],
      controllers: [BoxliteBoxController],
      providers: [
        {
          provide: BoxService,
          useValue: { getOutboundNetwork: getPolicy, getOutboundStatus: getStatus, setOutboundNetwork: setPolicy },
        },
        { provide: BoxStateWaiterService, useValue: {} },
        { provide: CheckpointRecoverService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: {} },
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
                  { permissions: userId === 'writer' ? [OrganizationResourcePermission.WRITE_BOXES] : [] },
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
    getPolicy.mockClear()
    getStatus.mockClear()
    setPolicy.mockClear()
  })

  async function request(
    method: 'GET' | 'PUT',
    prefix = '/org-1',
    token?: string,
    status = false,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(
      `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1${prefix}/boxes/box1/network/outbound${status ? '/status' : ''}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(method === 'PUT' ? { body: JSON.stringify({ mode: 'disabled' }) } : {}),
      },
    )
  }

  function expectNoDispatch(): void {
    expect(getPolicy).not.toHaveBeenCalled()
    expect(getStatus).not.toHaveBeenCalled()
    expect(setPolicy).not.toHaveBeenCalled()
  }

  it('allows read-only organization keys on canonical, explicit and legacy read routes', async () => {
    for (const prefix of ['', '/org-1', '/default']) {
      const response = await request('GET', prefix, 'outbound-read-key')
      expect(response.status).toBe(200)
      expect(response.headers.get('etag')).toBe('"rev-a"')
      expect(await response.json()).toEqual({ mode: 'enabled', allow_net: [] })
      expect((await request('GET', prefix, 'outbound-read-key', true)).status).toBe(200)
    }
    expect(getPolicy.mock.calls).toEqual(Array.from({ length: 3 }, () => ['box1', organizationId]))
    expect(getStatus.mock.calls).toEqual(getPolicy.mock.calls)
    expect(setPolicy).not.toHaveBeenCalled()
  })

  it('allows a scoped write key and preserves the public conditional policy request', async () => {
    for (const prefix of ['', '/org-1', '/default']) {
      const response = await request('PUT', prefix, 'outbound-write-key', false, { 'if-match': '"rev-a"' })
      expect(response.status).toBe(200)
      expect(response.headers.get('etag')).toBe('"rev-b"')
      expect(await response.json()).toEqual({ mode: 'disabled', allow_net: [] })
    }
    expect(setPolicy).toHaveBeenCalledTimes(3)
    for (const [boxId, policy, org, matches] of setPolicy.mock.calls) {
      expect([boxId, policy, org]).toEqual(['box1', { mode: 'disabled', allow_net: [] }, organizationId])
      expect(matches('rev-a')).toBe(true)
      expect(matches('other')).toBe(false)
    }
  })

  // This Service double captures the production predicate; PostgreSQL integration checks its mutation outcome.
  it.each<[string, string, boolean, boolean]>([
    ['wildcard with HTTP whitespace', ' \t*\t ', true, true],
    ['strong list', '"old", "rev-a"', true, false],
    ['weak current tag', 'W/"rev-a"', false, false],
    ['quoted comma', '"rev-a,other"', false, false],
    ['leading empty element', ', "rev-a"', true, false],
    ['interior empty element', '"old",, "rev-a"', true, false],
    ['trailing empty element', '"rev-a",', true, false],
    ['empty field', '', false, false],
    ['only empty elements', ', ,', false, false],
  ])('delivers the %s condition through the real HTTP controller', async (_name, header, current, other) => {
    for (const prefix of ['', '/org-1', '/default']) {
      expect((await request('PUT', prefix, 'outbound-write-key', false, { 'if-match': header })).status).toBe(200)
    }
    expect(setPolicy).toHaveBeenCalledTimes(3)
    for (const [, , , matches] of setPolicy.mock.calls) {
      expect(matches('rev-a')).toBe(current)
      expect(matches('other')).toBe(other)
    }
  })

  it.each([
    '"rev-a", broken',
    '"rev-a"tail',
    '"rev-a", *',
    ', *',
    'w/"rev-a"',
    '\u00a0"rev-a"',
    '"rev-a"\u00a0',
    '"' + 'a'.repeat(8192) + '"',
  ])('rejects malformed or oversized public condition %j before mutation', async (header) => {
    for (const prefix of ['', '/org-1', '/default']) {
      expect((await request('PUT', prefix, 'outbound-write-key', false, { 'if-match': header })).status).toBe(400)
    }
    expectNoDispatch()
  })

  it('enforces the actual permission policy for signed JWT owners, writers and read-only members', async () => {
    for (const user of ['owner', 'writer']) expect((await request('PUT', '/org-1', jwt(user))).status).toBe(200)
    expect((await request('GET', '/org-1', jwt('reader'))).status).toBe(200)
    expect((await request('PUT', '/org-1', jwt('reader'))).status).toBe(403)
    expect(setPolicy).toHaveBeenCalledTimes(2)
    expect(getPolicy).toHaveBeenCalledTimes(1)
  })

  it('rejects missing, unknown and expired credentials before reading or applying policy', async () => {
    for (const token of [undefined, 'unknown-key', 'outbound-expired-key', jwt('writer', true)]) {
      expect((await request('GET', '/org-1', token)).status).toBe(401)
      expect((await request('GET', '/org-1', token, true)).status).toBe(401)
      expect((await request('PUT', '/org-1', token)).status).toBe(401)
    }
    expectNoDispatch()
  })

  it('rejects read-only writes, nonmembers and machine credentials at the real guards', async () => {
    expect((await request('PUT', '/org-1', 'outbound-read-key')).status).toBe(403)
    for (const token of ['outbound-outsider-key', 'outbound-machine-key', jwt('outsider')]) {
      expect((await request('GET', '/org-1', token)).status).toBe(403)
      expect((await request('GET', '/org-1', token, true)).status).toBe(403)
      expect((await request('PUT', '/org-1', token)).status).toBe(403)
    }
    expectNoDispatch()
  })

  it('rejects foreign organization routes for scoped keys and signed JWT owners', async () => {
    for (const token of ['outbound-write-key', jwt('owner')]) {
      expect((await request('GET', '/org-other', token)).status).toBe(403)
      expect((await request('GET', '/org-other', token, true)).status).toBe(403)
      expect((await request('PUT', '/org-other', token)).status).toBe(403)
    }
    expectNoDispatch()
  })

  it('rejects internal candidate headers even from an authorized public writer', async () => {
    expect(
      (
        await request('PUT', '/org-1', 'outbound-write-key', false, {
          'x-boxlite-outbound-revision': 'caller-controlled',
        })
      ).status,
    ).toBe(400)
    expectNoDispatch()
  })
})
