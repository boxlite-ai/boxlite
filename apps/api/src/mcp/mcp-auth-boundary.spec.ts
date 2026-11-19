/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, JWTPayload, KeyLike, SignJWT } from 'jose'
import { JwtStrategy } from '../auth/jwt.strategy'
import { OrganizationResourcePermission as P } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'
import { McpAuthGuard } from './mcp-auth.guard'

const ISSUER = 'https://issuer.example.test/'
const RESOURCE = 'https://api.example.test/mcp'
const USER = { id: 'auth0|existing', email: 'existing@example.test', name: 'Existing', role: SystemRole.ADMIN }

describe('MCP OAuth with real signed tokens and a local JWKS endpoint', () => {
  let server: Server
  let jwksUri: string
  let privateKey: KeyLike
  let otherKey: KeyLike

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256')
    privateKey = keys.privateKey
    otherKey = (await generateKeyPair('RS256')).privateKey
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`
  })

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })

  function token(claims: JWTPayload = {}, signingKey = privateKey) {
    return new SignJWT({
      sub: USER.id,
      iss: ISSUER,
      aud: RESOURCE,
      exp: Math.floor(Date.now() / 1000) + 120,
      scope: 'write:boxes delete:boxes write:members',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(signingKey)
  }

  function fixture(turnstile = false) {
    const users = { findOne: jest.fn().mockResolvedValue(USER), create: jest.fn(), update: jest.fn() }
    const events = { recordFirstUse: jest.fn().mockResolvedValue(undefined) }
    const jwt = new JwtStrategy(
      { issuer: ISSUER, audience: 'dashboard', jwksUri },
      users as never,
      {
        getOrThrow: jest.fn(),
        get: jest.fn((key: string) => (key === 'turnstile' && turnstile ? {} : undefined)),
      } as never,
      events as never,
    )
    const apiKeys = { validate: jest.fn() }
    const organizations = {
      findDefault: jest.fn().mockResolvedValue({
        organizationId: 'default-org',
        permissions: new Set([P.WRITE_BOXES, P.WRITE_MEMBERS]),
      }),
    }
    const guard = new McpAuthGuard(jwt, apiKeys as never, { audience: RESOURCE } as never, organizations as never)
    return { guard, users, apiKeys, organizations }
  }

  function requestFor(bearer: string) {
    const request = {
      headers: { authorization: `Bearer ${bearer}`, 'x-organization-id': 'other-org' },
      get: jest.fn().mockReturnValue('other-org'),
      user: undefined as any,
    }
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
    return { request, context }
  }

  it('accepts a profile-free token for an existing user and limits its caller to default membership and MCP scopes', async () => {
    const { guard, users, apiKeys, organizations } = fixture()
    const { request, context } = requestFor(await token())

    await expect(guard.canActivate(context)).resolves.toBe(true)

    expect(request.user).toMatchObject({
      userId: USER.id,
      email: USER.email,
      role: SystemRole.USER,
      organizationId: 'default-org',
      apiKey: { permissions: [P.WRITE_BOXES], organizationId: 'default-org' },
    })
    expect(organizations.findDefault).toHaveBeenCalledWith(USER.id)
    expect(users.create).not.toHaveBeenCalled()
    expect(users.update).not.toHaveBeenCalled()
    expect(apiKeys.validate).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong audience', { aud: 'dashboard' }],
    ['wrong issuer', { iss: 'https://other.example.test/' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ])('rejects %s before account lookup, without API-key fallback', async (_label, claims) => {
    const { guard, users, apiKeys } = fixture()
    const { request, context } = requestFor(await token(claims))

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)

    expect(request.user).toBeUndefined()
    expect(users.findOne).not.toHaveBeenCalled()
    expect(apiKeys.validate).not.toHaveBeenCalled()
  })

  it('rejects a signature from a different key before account lookup', async () => {
    const { guard, users, apiKeys } = fixture()
    const { context } = requestFor(await token({}, otherKey))

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)

    expect(users.findOne).not.toHaveBeenCalled()
    expect(apiKeys.validate).not.toHaveBeenCalled()
  })

  it('requires Dashboard onboarding when a new identity has no email', async () => {
    const { guard, users, organizations } = fixture()
    users.findOne.mockResolvedValue(null)
    const { context } = requestFor(await token())

    await expect(guard.canActivate(context)).rejects.toMatchObject({ response: { code: 'email_required' } })

    expect(users.create).not.toHaveBeenCalled()
    expect(organizations.findDefault).not.toHaveBeenCalled()
  })

  it('requires Dashboard registration for a new identity when the registration gate is enabled', async () => {
    const { guard, users, organizations } = fixture(true)
    users.findOne.mockResolvedValue(null)
    const { context } = requestFor(await token({ email: 'new@example.test' }))

    await expect(guard.canActivate(context)).rejects.toMatchObject({ response: { code: 'registration_required' } })
    expect(users.create).not.toHaveBeenCalled()
    expect(organizations.findDefault).not.toHaveBeenCalled()
  })

  it('refuses a verified token whose user has no default membership', async () => {
    const { guard, organizations, apiKeys } = fixture()
    organizations.findDefault.mockResolvedValue(null)
    const { request, context } = requestFor(await token())

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException)

    expect(request.user).toBeUndefined()
    expect(apiKeys.validate).not.toHaveBeenCalled()
  })

  it('re-reads membership so a role change cannot retain previously granted write permissions', async () => {
    const { guard, organizations } = fixture()
    const bearer = await token()
    await guard.canActivate(requestFor(bearer).context)
    organizations.findDefault.mockResolvedValue({ organizationId: 'default-org', permissions: new Set() })
    const { request, context } = requestFor(bearer)

    await guard.canActivate(context)

    expect(request.user.apiKey.permissions).toEqual([])
    expect(organizations.findDefault).toHaveBeenCalledTimes(2)
  })
})
