/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { errors, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose'
import { JwtStrategy } from '../auth/jwt.strategy'
import type { TypedConfigService } from '../config/typed-config.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'

const ISSUER = 'https://issuer.test/'
const API_AUDIENCE = 'https://boxlite.test/api'
const MCP_RESOURCE = 'https://boxlite.test/api/mcp'
const CALLER = { userId: 'user-1', role: SystemRole.USER, email: 'user@example.com' }

describe('McpAuthGuard', () => {
  let jwks: Server
  let privateKey: KeyLike
  let strategy: JwtStrategy

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256')
    privateKey = keys.privateKey
    const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
    jwks = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicJwk] }))
    })
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    const jwksUri = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`
    // A real strategy, so signature, issuer, audience, and expiry go through its own
    // verification; the user mapping behind `validate` is the strategy's own concern.
    strategy = new JwtStrategy(
      { jwksUri, audience: API_AUDIENCE, issuer: ISSUER },
      {} as never,
      {} as never,
      {} as never,
    )
    jest.spyOn(strategy, 'validate').mockResolvedValue(CALLER)
  })

  afterAll(async () => {
    await new Promise((resolve) => jwks.close(resolve))
  })

  function tokenFor(audience: string): Promise<string> {
    return new SignJWT({ email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  function guard(resourceUrl?: string): McpAuthGuard {
    const configService = { get: () => resourceUrl } as unknown as TypedConfigService
    return new McpAuthGuard(strategy, new McpAuthMetadata(configService, strategy))
  }

  function requestWith(authorization?: string) {
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: authorization ? { authorization } : {},
    }
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
    return { request, context }
  }

  it('admits a token issued for the MCP resource and hands over its caller', async () => {
    const { request, context } = requestWith(`Bearer ${await tokenFor(MCP_RESOURCE)}`)

    await expect(guard(MCP_RESOURCE).canActivate(context)).resolves.toBe(true)
    expect(request.user).toEqual(CALLER)
  })

  it('refuses a dashboard token, issued for the API audience', async () => {
    const { context } = requestWith(`Bearer ${await tokenFor(API_AUDIENCE)}`)

    await expect(guard(MCP_RESOURCE).canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('leaves verifyToken on the API audience, which refuses an MCP token', async () => {
    await expect(strategy.verifyToken(await tokenFor(MCP_RESOURCE))).rejects.toBeInstanceOf(
      errors.JWTClaimValidationFailed,
    )
  })

  it('keeps the API audience until MCP_RESOURCE_URL is set', async () => {
    const { context } = requestWith(`Bearer ${await tokenFor(API_AUDIENCE)}`)

    await expect(guard(undefined).canActivate(context)).resolves.toBe(true)
  })

  it('refuses a request without a bearer token', async () => {
    const { context } = requestWith(undefined)

    await expect(guard(MCP_RESOURCE).canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
