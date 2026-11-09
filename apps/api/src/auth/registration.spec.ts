/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { ConflictException, INestApplication, Logger, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import axios from 'axios'
import * as jose from 'jose'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { QueryFailedError } from 'typeorm'
import { Context } from '../common/context/context'
import { TypedConfigService } from '../config/typed-config.service'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { UserAlreadyExistsException } from '../user/user-already-exists.exception'
import { User } from '../user/user.entity'
import { UserService } from '../user/user.service'
import { JwtStrategy } from './jwt.strategy'
import { LoginEventRecorder } from './login-event.recorder'
import { RegistrationJwtGuard } from './registration-jwt.guard'
import { RegistrationController } from './registration.controller'
import { RegistrationService } from './registration.service'
import { TurnstileService } from './turnstile.service'

const SECRET = 'private-turnstile-secret'
const CHALLENGE = 'private-one-use-response'
const ISSUER = 'https://issuer.example.com/'
const AUDIENCE = 'boxlite-api-audience'
const createdAt = new Date('2026-11-09T00:00:00Z')
const storedUser = {
  id: 'auth0|user-1',
  name: 'Stored User',
  email: 'stored@gmail.com',
  publicKeys: [],
  createdAt,
  role: 'user',
  emailVerified: true,
  keyPair: { privateKey: 'private-key', publicKey: 'public-key' },
} as User

describe('POST /api/auth/register', () => {
  let app: INestApplication
  let endpoint: string
  let identity: jose.JWTPayload
  let fetchMock: jest.SpyInstance
  let verifyJwt: jest.SpyInstance
  let validate: jest.SpyInstance
  let jwks: Server
  let signingKey: jose.KeyLike
  const users = { findOne: jest.fn(), create: jest.fn() }
  const loginEvents = { recordFirstUse: jest.fn() }
  const settings = { secretKey: SECRET, expectedHostnames: ['console.example.com'], action: 'signup', timeoutMs: 5000 }
  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'turnstile') return settings
      if (key === 'defaultRegion.id') return 'platform-default-region'
      throw new Error(`Unexpected config key: ${key}`)
    }),
  }

  beforeAll(async () => {
    const keyPair = await jose.generateKeyPair('RS256')
    signingKey = keyPair.privateKey
    const publicKey = { ...(await jose.exportJWK(keyPair.publicKey)), kid: 'registration-test-key', alg: 'RS256' }
    jwks = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ keys: [publicKey] }))
    })
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    const jwt = new JwtStrategy(
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`,
      },
      users as never,
      loginEvents as never,
    )
    const module = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        RegistrationService,
        RegistrationJwtGuard,
        TurnstileService,
        { provide: JwtStrategy, useValue: jwt },
        { provide: UserService, useValue: users },
        { provide: TypedConfigService, useValue: config },
        { provide: LoginEventRecorder, useValue: loginEvents },
      ],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0, '127.0.0.1')
    endpoint = `${await app.getUrl()}/api/auth/register`
  })

  beforeEach(() => {
    identity = { sub: storedUser.id, name: 'Token User', email: '  Token@GMAIL.COM  ', email_verified: true }
    users.findOne.mockReset().mockResolvedValue(null)
    users.create.mockReset().mockImplementation(async (dto) => ({ ...storedUser, ...dto }))
    loginEvents.recordFirstUse.mockReset().mockResolvedValue(undefined)
    config.getOrThrow.mockClear()
    verifyJwt = jest.spyOn(jose, 'jwtVerify')
    validate = jest.spyOn(app.get(JwtStrategy), 'validate')
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, action: 'signup', hostname: 'console.example.com' })),
      )
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await app?.close()
    await new Promise<void>((resolve, reject) => jwks?.close((error) => (error ? reject(error) : resolve())))
  })

  const sign = (claims: jose.JWTPayload) =>
    new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'registration-test-key' })
      .sign(signingKey)

  const post = async (body: unknown = { turnstileToken: CHALLENGE }, authorization?: string | null) => {
    const header = authorization === undefined ? `Bearer ${await sign(identity)}` : authorization
    return axios.post(endpoint, body, {
      headers: header ? { Authorization: header } : {},
      validateStatus: () => true,
      proxy: false,
    })
  }

  it('creates a user from verified JWT claims and returns only UserDto with 201', async () => {
    const response = await post({ turnstileToken: CHALLENGE, id: 'spoofed', email: 'spoofed@gmail.com', role: 'admin' })

    expect(response.status).toBe(201)
    expect(response.data).toEqual({
      id: storedUser.id,
      name: 'Token User',
      email: 'token@gmail.com',
      publicKeys: [],
      createdAt: createdAt.toISOString(),
    })
    expect(users.create).toHaveBeenCalledWith(
      {
        id: storedUser.id,
        name: 'Token User',
        email: 'token@gmail.com',
        emailVerified: true,
        defaultOrganizationDefaultRegionId: 'platform-default-region',
      },
      Context.user({ userId: storedUser.id, authMethod: 'jwt' }),
    )
    expect(verifyJwt).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      audience: AUDIENCE,
      issuer: ISSUER,
      algorithms: ['RS256'],
    })
    expect(validate).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).toHaveBeenCalledWith(storedUser.id, expect.objectContaining(identity))
    expect(JSON.stringify(response.data)).not.toContain(SECRET)
    expect(JSON.stringify(response.data)).not.toContain(CHALLENGE)
  })

  it('returns an existing user with 200 without profile claims, a challenge request or profile changes', async () => {
    identity = { sub: storedUser.id }
    users.findOne.mockResolvedValue(storedUser)
    const response = await post()

    expect(response.status).toBe(200)
    expect(response.data).toEqual({
      id: storedUser.id,
      name: storedUser.name,
      email: storedUser.email,
      publicKeys: [],
      createdAt: createdAt.toISOString(),
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(users.create).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })

  it.each([null, {}, { other: CHALLENGE }])('requires a challenge field even for an existing user', async (body) => {
    users.findOne.mockResolvedValue(storedUser)
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(response.data.code).toBe('turnstile_token_required')
    expect(users.findOne).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([null, 42, false, '', 'x'.repeat(2049), [], {}])(
    'rejects an invalid challenge field',
    async (turnstileToken) => {
      users.findOne.mockResolvedValue(storedUser)
      const response = await post({ turnstileToken })
      expect(response.status).toBe(400)
      expect(response.data.code).toBe('turnstile_token_invalid')
      expect(users.findOne).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each([1, 2048])('accepts a challenge with length %i', async (length) => {
    expect((await post({ turnstileToken: 'x'.repeat(length) })).status).toBe(201)
  })

  it.each([null, 'Basic access-token', 'Bearer invalid-token'])(
    'rejects missing or invalid bearer credentials',
    async (header) => {
      expect((await post({ turnstileToken: CHALLENGE }, header)).status).toBe(401)
      expect(users.findOne).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, '', '   ', 42])('rejects a verified token without a usable identity', async (sub) => {
    identity = { sub } as jose.JWTPayload
    expect((await post()).status).toBe(401)
    expect(users.findOne).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong audience', { aud: 'another-api' }],
    ['wrong issuer', { iss: 'https://other-issuer.example.com/' }],
    ['expired', { exp: 1 }],
  ])('rejects a signed token with %s before registration side effects', async (_reason, claims) => {
    const token = await sign({ ...identity, ...(claims as jose.JWTPayload) })
    expect((await post({ turnstileToken: CHALLENGE }, `Bearer ${token}`)).status).toBe(401)
    expect(users.findOne).not.toHaveBeenCalled()
    expect(users.create).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })

  it('uses the Okta uid as user ID and sub as email without requiring email_verified', async () => {
    identity = { cid: 'okta-client', uid: 'okta-user', sub: 'Okta@GMAIL.COM', username: 'Okta Name' }
    expect((await post()).status).toBe(201)
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'okta-user',
        email: 'okta@gmail.com',
        name: 'Okta Name',
        emailVerified: false,
      }),
      Context.user({ userId: 'okta-user', authMethod: 'jwt' }),
    )
  })

  it('uses Unknown when the token carries no name', async () => {
    identity = { sub: storedUser.id, email: 'new@gmail.com' }
    expect((await post()).status).toBe(201)
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Unknown' }),
      Context.user({ userId: storedUser.id, authMethod: 'jwt' }),
    )
  })

  it.each([
    [undefined, 403, 'email_required'],
    ['', 403, 'email_required'],
    ['   ', 403, 'email_required'],
    [42, 403, 'email_required'],
    ['bad email', 400, 'invalid_email'],
    ['new@mailinator.com', 403, 'disposable_email'],
  ])('rejects an unusable registration email before Siteverify', async (email, status, code) => {
    identity.email = email
    const response = await post()
    expect(response.status).toBe(status)
    expect(response.data.code).toBe(code)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(users.create).not.toHaveBeenCalled()
  })

  it.each([
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, 403, 'turnstile_verification_failed'],
    [{ success: false, 'error-codes': ['invalid-input-secret'] }, 503, 'turnstile_unavailable'],
  ])(
    'returns the Siteverify error contract without creating local state or exposing secrets',
    async (upstream, status, code) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...upstream, message: `${SECRET} ${CHALLENGE}` })))
      const response = await post()
      expect(response.status).toBe(status)
      expect(response.data.code).toBe(code)
      expect(users.create).not.toHaveBeenCalled()
      expect(JSON.stringify(response.data)).not.toContain(SECRET)
      expect(JSON.stringify(response.data)).not.toContain(CHALLENGE)
    },
  )

  it.each(['user_id_pk', 'PK_cace4a159ff9f2512dd42373760'])(
    'recovers primary-key conflict %s by rereading the same identity and returning 200',
    async (constraint) => {
      users.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(storedUser)
      const conflict = new QueryFailedError(
        'INSERT INTO "user"',
        [],
        Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint }),
      )
      const creator = new UserService(
        {} as never,
        {} as never,
        {
          transaction: async (work) =>
            work({
              insert: async () => {
                throw conflict
              },
            }),
        } as never,
      )
      jest
        .spyOn(creator as never, 'generatePrivateKey')
        .mockResolvedValue({ privateKey: 'private', publicKey: 'public' } as never)
      users.create.mockImplementation((dto, ctx) => creator.create(dto, ctx))
      const response = await post()
      expect(response.status).toBe(200)
      expect(response.data.id).toBe(storedUser.id)
      expect(response.data.name).toBe(storedUser.name)
      expect(users.findOne.mock.calls).toEqual([[storedUser.id], [storedUser.id]])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
    },
  )

  it('keeps 409 when a precise conflict cannot be reread', async () => {
    users.create.mockRejectedValue(new UserAlreadyExistsException(new Error('missing after conflict')))
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.data.code).toBe('user_already_exists')
  })

  it.each([
    [new ConflictException({ code: 'user_already_exists', message: 'Other conflict' }), 409],
    [
      new QueryFailedError('INSERT INTO organization', [], Object.assign(new Error('org conflict'), { code: '23505' })),
      500,
    ],
  ])('does not convert an unrelated failure into an existing-user success', async (error, status) => {
    users.create.mockRejectedValue(error)
    const response = await post()
    expect(response.status).toBe(status)
    expect(users.findOne).toHaveBeenCalledTimes(1)
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })
})
