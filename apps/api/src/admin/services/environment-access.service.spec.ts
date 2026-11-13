import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { INestApplication, Injectable } from '@nestjs/common'
import { PassportModule, PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-http-bearer'
import { Test } from '@nestjs/testing'
import { TypedConfigService } from '../../config/typed-config.service'
import { AdminEnvironmentAccessController } from '../controllers/environment-access.controller'
import { EnvironmentAccessService } from './environment-access.service'
import { EnvironmentAccessCleanupService } from './environment-access-cleanup.service'

@Injectable()
class FixtureKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  validate(token: string) {
    return token === 'admin'
      ? { userId: 'admin-actor', role: 'admin', apiKey: {} }
      : token === 'member'
        ? { userId: 'ordinary-user', role: 'user' }
        : null
  }
}
@Injectable()
class FixtureJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  validate() {
    return null
  }
}

describe('environment access Admin HTTP boundary and Auth0 requests', () => {
  let server: Server, app: INestApplication, origin: string
  let profile: any, requests: Array<{ method: string; path: string; body: any }>, settings: Record<string, unknown>
  let providerStatus: number
  const cleanup = { describe: jest.fn(), revoke: jest.fn() }
  const noCleanup = { complete: true, apiKeys: { deleted: 0, complete: true }, organizations: [], boxes: [] }
  beforeEach(async () => {
    requests = []
    providerStatus = 200
    profile = {
      user_id: 'auth0|tester',
      email: 'Tester@Example.com',
      email_verified: true,
      app_metadata: {
        other_product: { keep: true },
        boxlite_stage_access: { email: 'tester@example.com', allowed: true },
      },
    }
    cleanup.describe.mockResolvedValue({ organizations: [], truncated: false })
    cleanup.revoke.mockResolvedValue(noCleanup)
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ method: req.method!, path: req.url!, body })
      res.setHeader('Content-Type', 'application/json')
      if (providerStatus !== 200) {
        res.statusCode = providerStatus
        res.end('{}')
        return
      }
      if (req.url === '/oauth/token') {
        res.end(JSON.stringify({ access_token: 'test-management-token', expires_in: 3600 }))
        return
      }
      expect(req.headers.authorization).toBe('Bearer test-management-token')
      if (req.url?.startsWith('/api/v2/users-by-email?')) {
        res.end(JSON.stringify([profile]))
        return
      }
      if (req.url === '/api/v2/users/auth0%7Ctester') {
        if (req.method === 'PATCH') profile.app_metadata = { ...profile.app_metadata, ...body.app_metadata }
        res.end(JSON.stringify(profile))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    settings = {
      'oidc.environmentAccess': 'dev',
      'oidc.managementApi.baseUrl': `${provider}/api/v2`,
      'oidc.managementApi.tokenUrl': `${provider}/oauth/token`,
      'oidc.managementApi.clientId': 'fixture-client',
      'oidc.managementApi.clientSecret': 'fixture-secret',
      'oidc.managementApi.audience': `${provider}/api/v2/`,
    }
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminEnvironmentAccessController],
      providers: [
        FixtureKeyStrategy,
        FixtureJwtStrategy,
        EnvironmentAccessService,
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => settings[key], getOrThrow: (key: string) => settings[key] },
        },
        { provide: EnvironmentAccessCleanupService, useValue: cleanup },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    origin = await app.getUrl()
  })
  afterEach(async () => {
    await app?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    jest.clearAllMocks()
  })
  const send = async (body?: unknown, token = 'admin', query = 'Tester@Example.com') => {
    const response = await fetch(
      `${origin}/api/admin/environment-access${body ? '' : `?email=${encodeURIComponent(query)}`}`,
      {
        method: body ? 'PUT' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    )
    return { status: response.status, body: await response.json() }
  }
  it.each(['member', 'invalid'])('denies %s before accessing Auth0 or cleanup', async (token) => {
    expect((await send(undefined, token)).status).toBe(token === 'member' ? 403 : 401)
    expect((await send({ userId: profile.user_id, email: profile.email, allowed: false }, token)).status).toBe(
      token === 'member' ? 403 : 401,
    )
    expect(requests).toEqual([])
    expect(cleanup.revoke).not.toHaveBeenCalled()
  })
  it('deduplicates exact/lowercase lookups and reuses a bounded Management token', async () => {
    const result = await send()
    expect(result.status).toBe(200)
    expect(result.body.items).toHaveLength(1)
    expect(result.body.items[0]).toMatchObject({ userId: 'auth0|tester', granted: false, denied: false })
    expect(requests.filter((r) => r.path === '/oauth/token')).toHaveLength(1)
    expect(requests.filter((r) => r.path.startsWith('/api/v2/users-by-email'))).toHaveLength(2)
  })
  it('patches only the current environment root key, binds the full normalized email and reads back', async () => {
    const result = await send({ userId: profile.user_id, email: profile.email, allowed: true })
    expect(result.status).toBe(200)
    expect(result.body.item.granted).toBe(true)
    const patch = requests.find((r) => r.method === 'PATCH')!
    expect(patch.body).toEqual({
      app_metadata: {
        boxlite_dev_access: {
          email: 'tester@example.com',
          allowed: true,
          updatedBy: 'admin-actor',
          updatedAt: expect.any(String),
        },
      },
    })
    expect(profile.app_metadata.other_product).toEqual({ keep: true })
    expect(profile.app_metadata.boxlite_stage_access.allowed).toBe(true)
    expect(cleanup.revoke).not.toHaveBeenCalled()
  })
  it('revokes an existing Auth0 identity without fabricating local memberships or keys', async () => {
    const result = await send({ userId: profile.user_id, email: profile.email, allowed: false })
    expect(result.status).toBe(200)
    expect(result.body.item.denied).toBe(true)
    expect(result.body.cleanup).toEqual(noCleanup)
    expect(cleanup.revoke).toHaveBeenCalledWith(
      'auth0|tester',
      expect.objectContaining({ actor: { userId: 'admin-actor', authMethod: 'api_key' } }),
    )
  })
  it('retains partial cleanup results and supports explicit repeated revoke', async () => {
    cleanup.revoke.mockResolvedValue({ ...noCleanup, complete: false, errorCode: 'membership_scan_failed' })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await send({ userId: profile.user_id, email: profile.email, allowed: false })
      expect(result.status).toBe(200)
      expect(result.body.cleanup.complete).toBe(false)
    }
    expect(cleanup.revoke).toHaveBeenCalledTimes(2)
  })
  it('rejects a changed email before any write', async () => {
    expect((await send({ userId: profile.user_id, email: 'other@example.com', allowed: false })).status).toBe(409)
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect(cleanup.revoke).not.toHaveBeenCalled()
  })
  it.each([
    { userId: 'auth0|tester', email: 'invalid', allowed: true },
    { userId: 'auth0|tester', email: 'tester@example.com', allowed: 'false' },
    { userId: '', email: 'tester@example.com', allowed: false },
    { userId: 'auth0|tester', email: 'tester@example.com', allowed: false, environment: 'stage' },
  ])('rejects malformed or caller-selected environment input', async (body) => {
    expect((await send(body)).status).toBe(400)
    expect(requests).toEqual([])
  })
  it('fails closed on provider failure without retrying a write or cleaning local data', async () => {
    providerStatus = 429
    expect((await send({ userId: profile.user_id, email: profile.email, allowed: false })).status).toBe(503)
    expect(cleanup.revoke).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
  })
  it('does not expose Management credentials and disables this route outside the selected environments', async () => {
    settings['oidc.environmentAccess'] = undefined
    const result = await send()
    expect(result.status).toBe(404)
    expect(JSON.stringify(result.body)).not.toContain('fixture-secret')
    expect(requests).toEqual([])
  })
})
