/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { ExecutionContext, MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import axios from 'axios'
import { AppModule } from '../app.module'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { ConfigController } from '../config/config.controller'
import { configureHttpNetwork } from '../config/http-network'
import { OidcMetadataService } from '../config/oidc-metadata.service'
import { TypedConfigService } from '../config/typed-config.service'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { UserController } from '../user/user.controller'
import { User } from '../user/user.entity'
import { UserService } from '../user/user.service'
import { CombinedAuthGuard } from './combined-auth.guard'
import { FailedAuthTrackerService } from './failed-auth-tracker.service'
import { JwtStrategy } from './jwt.strategy'
import { LoginEventRecorder } from './login-event.recorder'
import { RegistrationJwtGuard } from './registration-jwt.guard'
import { RegistrationRateLimitGuard } from './registration-rate-limit.guard'
import { RegistrationController } from './registration.controller'
import { RegistrationService } from './registration.service'
import { TurnstileService } from './turnstile.service'

jest.mock('../boxlite-rest/boxlite-rest.module', () => ({ BoxliteRestModule: class {} }))
jest.mock('../mcp/mcp.module', () => ({ McpModule: class {} }))

const ORIGIN = 'https://console.example.com'
const user = {
  id: 'auth0|registered',
  name: 'Existing User',
  email: 'existing@example.com',
  publicKeys: [],
  createdAt: new Date('2026-11-09T00:00:00Z'),
} as User
const limits = { limit: 2, ttl: 60 }
const config = new TypedConfigService(
  new ConfigService({
    version: 'test',
    environment: 'test',
    maintananceMode: false,
    dashboardUrl: ORIGIN,
    oidc: { issuer: 'https://issuer.example.com/', clientId: 'dashboard', audience: 'api' },
    proxy: { templateUrl: 'https://proxy.example.com', toolboxUrl: 'https://toolbox.example.com' },
    turnstile: { sitekey: 'public-sitekey', action: 'signup' },
    rateLimit: { registration: limits, failedAuth: { limit: 1, ttl: 60 } },
  }),
)
const redis = {
  options: { keyPrefix: '' },
  eval: jest.fn(),
  get: jest.fn(),
  pttl: jest.fn(),
  incr: jest.fn(),
  pexpire: jest.fn(),
  set: jest.fn(),
}
const jwt = { verifyToken: jest.fn() }
const users = { findOne: jest.fn(), create: jest.fn() }
const turnstile = { verify: jest.fn() }
const loginEvents = { recordFirstUse: jest.fn() }

@Module({
  controllers: [RegistrationController, ConfigController, UserController],
  providers: [
    RegistrationService,
    RegistrationJwtGuard,
    RegistrationRateLimitGuard,
    { provide: JwtStrategy, useValue: jwt },
    { provide: UserService, useValue: users },
    { provide: TurnstileService, useValue: turnstile },
    { provide: LoginEventRecorder, useValue: loginEvents },
    { provide: TypedConfigService, useValue: config },
    { provide: getRedisConnectionToken('throttler'), useValue: redis },
    { provide: OidcMetadataService, useValue: { getEndSessionState: async () => 'present' } },
  ],
})
class RegistrationHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    AppModule.prototype.configure.call(this, consumer)
  }
}

describe('Registration rate limit HTTP boundary', () => {
  let app: NestExpressApplication | undefined
  let origin: string
  let steps: string[]
  let counts: Map<string, number>
  let trackFailure: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    steps = []
    counts = new Map()
    limits.limit = 2
    redis.eval.mockReset().mockImplementation(async (_script, _keys, key: string) => {
      steps.push('limit')
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return [count, 1501]
    })
    redis.get.mockReset().mockResolvedValue(null)
    redis.pttl.mockReset().mockResolvedValue(60_000)
    redis.incr.mockReset().mockResolvedValue(1)
    jwt.verifyToken.mockReset().mockImplementation(async (token: string) => {
      steps.push('jwt')
      if (token !== 'valid-access-token') throw new Error('Invalid token')
      return { sub: user.id }
    })
    users.findOne.mockReset().mockResolvedValue(user)
    users.create.mockReset()
    turnstile.verify.mockReset()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    jest.restoreAllMocks()
  })

  async function start(trustedProxies: string[] = []) {
    const fixture = await Test.createTestingModule({ imports: [RegistrationHttpModule] })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().user = { userId: user.id }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = fixture.createNestApplication<NestExpressApplication>()
    app.useLogger(false)
    configureHttpNetwork(app, trustedProxies, { DASHBOARD_URL: ORIGIN })
    app.setGlobalPrefix('api')
    const tracker = new FailedAuthTrackerService(redis as never, config)
    trackFailure = jest.spyOn(tracker, 'incrementFailedAuth')
    app.useGlobalFilters(new AllExceptionsFilter(tracker))
    await app.listen(0, '127.0.0.1')
    origin = await app.getUrl()
  }

  const post = (headers: Record<string, string> = { Authorization: 'Bearer valid-access-token' }) =>
    axios.post(
      `${origin}/api/auth/register`,
      { turnstileToken: 'challenge-token' },
      {
        headers,
        proxy: false,
        timeout: 5000,
        validateStatus: () => true,
      },
    )
  const get = (path: string) =>
    axios.get(`${origin}/api/${path}`, {
      proxy: false,
      timeout: 5000,
      validateStatus: () => true,
    })

  it('counts an invalid JWT before verification and keeps its 401 despite an existing failed-auth block', async () => {
    redis.get.mockResolvedValue('blocked')
    await start()
    expect((await get('config')).status).toBe(429)
    expect(redis.get).toHaveBeenCalled()
    redis.get.mockClear()

    const response = await post({ Authorization: 'Bearer invalid-access-token' })

    expect(response.status).toBe(401)
    expect(response.data.message).toBe('Invalid credentials')
    expect(response.headers['retry-after']).toBeUndefined()
    expect(steps).toEqual(['limit', 'jwt'])
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.get).not.toHaveBeenCalled()
    expect(trackFailure).not.toHaveBeenCalled()
    expect(users.findOne).not.toHaveBeenCalled()
  })

  it('counts requests without a JWT and stops excess requests before authentication', async () => {
    await start()
    expect((await post({})).status).toBe(401)
    expect((await post({})).status).toBe(401)
    const rejected = await post({})
    expect(rejected.status).toBe(429)
    expect(rejected.data.code).toBe('registration_rate_limited')
    expect(redis.eval).toHaveBeenCalledTimes(3)
    expect(jwt.verifyToken).not.toHaveBeenCalled()
    expect(trackFailure).not.toHaveBeenCalled()
  })

  it('counts existing-user retries and exposes the remaining retry time to the Dashboard', async () => {
    await start()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post()
      expect(response.status).toBe(200)
      expect(response.data.id).toBe(user.id)
    }
    const response = await post({ Authorization: 'Bearer valid-access-token', Origin: ORIGIN })
    expect(response.status).toBe(429)
    expect(response.data.code).toBe('registration_rate_limited')
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(response.headers['access-control-expose-headers']).toContain('Retry-After')
    expect(redis.eval).toHaveBeenCalledTimes(3)
    expect(jwt.verifyToken).toHaveBeenCalledTimes(2)
    expect(users.findOne).toHaveBeenCalledTimes(2)
    expect(users.create).not.toHaveBeenCalled()
    expect(turnstile.verify).not.toHaveBeenCalled()
  })

  it('keeps config, user queries and preflight outside the registration allowance', async () => {
    await start()
    expect((await get('config')).status).toBe(200)
    const me = await get('users/me')
    expect(me.status).toBe(200)
    expect(me.data.id).toBe(user.id)
    const preflight = await axios.options(`${origin}/api/auth/register`, {
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      proxy: false,
      timeout: 5000,
      validateStatus: () => true,
    })
    expect(preflight.status).toBe(204)
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('returns 503 without authentication or account access when registration Redis fails', async () => {
    redis.eval.mockRejectedValue(new Error('Redis unavailable'))
    await start()
    const response = await post()
    expect(response.status).toBe(503)
    expect(response.data.code).toBe('registration_rate_limit_unavailable')
    expect(jwt.verifyToken).not.toHaveBeenCalled()
    expect(users.findOne).not.toHaveBeenCalled()
    expect(turnstile.verify).not.toHaveBeenCalled()
    expect((await get('users/me')).status).toBe(200)
  })

  it('uses the first untrusted address behind real trusted hops despite forged leading headers', async () => {
    await start(['127.0.0.1/8', '10.0.0.0/8'])
    const headers = (forged: string) => ({
      Authorization: 'Bearer valid-access-token',
      'X-Forwarded-For': `${forged}, 203.0.113.9, 10.0.0.5`,
      'CF-Connecting-IP': forged,
    })
    expect((await post(headers('198.51.100.10'))).status).toBe(200)
    expect((await post(headers('198.51.100.20'))).status).toBe(200)
    expect((await post(headers('198.51.100.30'))).status).toBe(429)
    expect([...counts.entries()]).toEqual([['boxlite:registration:ip:203.0.113.9', 3]])
  })

  it.each([{ trusted: [] }, { trusted: ['10.0.0.0/8'] }])(
    'uses the peer IP with trusted proxies $trusted',
    async ({ trusted }) => {
      await start(trusted)
      for (const forwarded of ['198.51.100.10', '198.51.100.20']) {
        expect(
          (
            await post({
              Authorization: 'Bearer valid-access-token',
              'X-Forwarded-For': forwarded,
              'CF-Connecting-IP': forwarded,
            })
          ).status,
        ).toBe(200)
      }
      expect([...counts.entries()]).toEqual([['boxlite:registration:ip:127.0.0.1', 2]])
    },
  )
})
