/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { UnauthorizedException } from '@nestjs/common'
import { exportJWK, generateKeyPair, KeyLike, SignJWT, jwtVerify } from 'jose'
import { JwtStrategy } from '../auth/jwt.strategy'
import { SystemRole } from '../user/enums/system-role.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { McpAuthorizationService } from './mcp-authorization.service'
import { McpConsentService } from './mcp-consent.service'

const ISSUER = 'https://issuer.test/'
const RESOURCE = 'https://app.test/api/mcp'
const ORG = randomUUID()
const GRANT = randomUUID()
const SECRET = 'test-secret-not-used-in-production-32-bytes'

describe('MCP OAuth and consent', () => {
  let jwks: Server
  let key: KeyLike
  let jwt: JwtStrategy
  let authorization: McpAuthorizationService
  let consent: McpConsentService
  const grants = { read: jest.fn(), create: jest.fn() }
  const memberships = { findOne: jest.fn() }
  const config = {
    get: (name: string) =>
      (
        ({
          'mcp.resourceUrl': RESOURCE,
          'mcp.oauthEnabled': true,
          'mcp.oauthClientIds': ['client'],
          'mcp.consentSecret': SECRET,
        }) as Record<string, unknown>
      )[name],
  }
  const organization = { id: ORG, name: 'Team' }
  const organizations = {
    findOne: jest.fn().mockResolvedValue(organization),
    findByUserWithDefaultFlag: jest.fn().mockResolvedValue([{ organization }]),
    assertOrganizationIsNotSuspended: jest.fn(),
  }
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    key = pair.privateKey
    const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
    jwks = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys: [publicKey] }))
    })
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    jwt = new JwtStrategy(
      {
        issuer: ISSUER,
        audience: 'https://dashboard.test',
        jwksUri: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`,
      },
      {} as never,
      {} as never,
      {} as never,
    )
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => jwks.close(() => resolve()))
  })
  beforeEach(() => {
    grants.read.mockReset().mockResolvedValue({
      id: GRANT,
      user_id: 'user',
      organization_id: ORG,
      client_id: 'client',
      resource: RESOURCE,
      scopes: ['boxes:read'],
    })
    grants.create.mockReset().mockImplementation(async (grant) => ({ ...grant, id: GRANT }))
    memberships.findOne.mockReset().mockResolvedValue({ role: OrganizationMemberRole.OWNER })
    authorization = new McpAuthorizationService(
      {} as never,
      { findOne: async () => ({ id: 'user', role: SystemRole.USER }) } as never,
      organizations as never,
      memberships as never,
      grants as never,
      jwt,
      config as never,
    )
    consent = new McpConsentService(config as never, jwt, authorization, organizations as never, grants as never)
  })
  const token = (overrides: Record<string, unknown> = {}, audience = RESOURCE) =>
    new SignJWT({
      azp: 'client',
      scope: 'boxes:read boxes:write boxes:delete',
      'https://boxlite.ai/mcp/grant_id': GRANT,
      'https://boxlite.ai/mcp/organization_id': ORG,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('user')
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key)

  it('intersects token, grant and membership scopes even for owners and rechecks revocation', async () => {
    const caller = await authorization.authenticate(await token())
    expect(caller.scopes).toEqual(['boxes:read'])
    await expect(authorization.authorize(caller, 'boxes:write')).rejects.toMatchObject({ status: 403 })
    grants.read.mockRejectedValue(new UnauthorizedException('revoked'))
    await expect(authorization.authorize(caller, 'boxes:read')).rejects.toMatchObject({ status: 401 })
    expect(JSON.stringify(caller.credential)).not.toContain('eyJ')
  })
  it('rejects a dashboard audience, missing grant, client/org mismatch and expired dispatch identity', async () => {
    await expect(authorization.authenticate(await token({}, 'https://dashboard.test'))).rejects.toMatchObject({
      status: 401,
    })
    await expect(
      authorization.authenticate(await token({ 'https://boxlite.ai/mcp/grant_id': null })),
    ).rejects.toMatchObject({ status: 401 })
    await expect(authorization.authenticate(await token({ azp: 'other' }))).rejects.toMatchObject({ status: 401 })
    await expect(
      authorization.authenticate(await token({ 'https://boxlite.ai/mcp/organization_id': randomUUID() })),
    ).rejects.toMatchObject({ status: 401 })
    const caller = await authorization.authenticate(await token())
    if (caller.credential.kind !== 'oauth') throw new Error('expected OAuth')
    caller.credential.expiresAt = 0
    await expect(authorization.authorize(caller, 'boxes:read')).rejects.toMatchObject({ status: 401 })
  })
  it('denies access after live membership removal', async () => {
    const caller = await authorization.authenticate(await token())
    memberships.findOne.mockResolvedValue(null)
    await expect(authorization.authorize(caller, 'boxes:read')).rejects.toMatchObject({ status: 403 })
  })

  async function challenge(overrides: Record<string, unknown> = {}, expiry = '5m') {
    return new SignJWT({
      client_id: 'client',
      client_name: 'Agent',
      resource: RESOURCE,
      scopes: ['boxes:read', 'boxes:write'],
      nonce: randomUUID(),
      ...overrides,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user')
      .setIssuer('issuer.test')
      .setAudience('boxlite-mcp-consent')
      .setExpirationTime(expiry)
      .sign(new TextEncoder().encode(SECRET))
  }
  it('shows a verified client/org choice and signs an expiring, state-bound continuation', async () => {
    const input = await challenge()
    expect(await consent.preview('user', input)).toMatchObject({ client_name: 'Agent', organizations: [{ id: ORG }] })
    const response = await consent.approve('user', input, 'auth0-state', ORG, ['boxes:read'])
    expect(response.continue_url).toBe(`${ISSUER}continue`)
    const verified = await jwtVerify(response.session_token, new TextEncoder().encode(SECRET), {
      algorithms: ['HS256'],
      issuer: RESOURCE,
      audience: 'boxlite-mcp-continue',
    })
    expect(verified.payload).toMatchObject({
      sub: 'user',
      state: 'auth0-state',
      organization_id: ORG,
      grant_id: GRANT,
      scopes: ['boxes:read'],
    })
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(120)
  })
  it('rejects forged/expired/wrong-user challenges, scope escalation and replay', async () => {
    const input = await challenge()
    await expect(consent.preview('other', input)).rejects.toMatchObject({ status: 401 })
    await expect(consent.preview('user', `${input.slice(0, -8)}invalid`)).rejects.toMatchObject({ status: 401 })
    await expect(consent.preview('user', await challenge({}, '-1s'))).rejects.toMatchObject({ status: 401 })
    await expect(consent.approve('user', input, 'state', ORG, ['boxes:read', 'boxes:delete'])).rejects.toMatchObject({
      status: 403,
    })
    grants.create.mockRejectedValue({ status: 409 })
    await expect(consent.approve('user', input, 'state', ORG, ['boxes:read'])).rejects.toMatchObject({ status: 409 })
  })
})
