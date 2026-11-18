/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import axios from 'axios'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { TypedConfigService } from '../../config/typed-config.service'
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter'
import { SystemRole } from '../../user/enums/system-role.enum'
import { UserService } from '../../user/user.service'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { CouponClaimsService } from '../services/coupon-claims.service'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { CouponClaimsController } from './coupon-claims.controller'

const organizationId = 'abcde000-0000-4000-8000-000000000001'
const otherOrganizationId = randomUUID()
const claim = { eventId: randomUUID(), couponCode: 'ABCD-EFGH' }
const receipt = {
  eventId: claim.eventId,
  billingEventId: randomUUID(),
  organizationId,
  type: 'RedeemCouponAfterBindCard',
  status: 'pending',
  result: null,
  replayed: false,
}
const credited = {
  outcome: 'processed',
  creditCents: 750,
  couponId: randomUUID(),
  redemptionId: randomUUID(),
  walletTransactionId: randomUUID(),
}
const serviceToken = 'test-commerce-service'
type Delivery = { method: string; path: string; authorization: string; body: Record<string, unknown> }
type CommerceReply = { status: number; body: unknown }

describe('POST /api/organizations/:organizationId/coupon-claims', () => {
  let app: INestApplication
  let server: Server
  let upstream: string
  let endpoint: string
  let commerceReply: CommerceReply | ((delivery: Delivery) => CommerceReply | 'disconnect')
  const deliveries: Delivery[] = []
  const roles = new Map<string, OrganizationMemberRole>()
  const cache = new Map<string, string>()
  const tokens: Record<string, string> = {}
  const settings: Record<string, unknown> = {}

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'coupon-claims', alg: 'RS256' }] }
    server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/jwks') {
        res.end(JSON.stringify(jwks))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        res.writeHead(400).end()
        return
      }
      const delivery = {
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body,
      }
      deliveries.push(delivery)
      const reply = typeof commerceReply === 'function' ? commerceReply(delivery) : commerceReply
      if (reply === 'disconnect') {
        res.destroy()
        return
      }
      res.statusCode = reply.status
      res.end(JSON.stringify(reply.body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const users = {
      findOne: (id: string) => ({
        id,
        role: id === 'admin' ? SystemRole.ADMIN : SystemRole.USER,
        emailVerified: id !== 'unverified',
      }),
    }
    const config = { get: (key: string) => settings[key] }
    const jwt = new JwtStrategy(
      { issuer: upstream, audience: 'dashboard', jwksUri: `${upstream}/jwks` },
      users as never,
      config as never,
      { recordFirstUse: jest.fn() } as never,
    )
    for (const userId of ['owner', 'member', 'unverified', 'admin']) {
      tokens[userId] = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'coupon-claims' })
        .setIssuer(upstream)
        .setAudience('dashboard')
        .setSubject(userId)
        .setExpirationTime('1h')
        .sign(privateKey)
    }
    const membership = {
      findOne: (org: string, userId: string) =>
        org.toLowerCase() === organizationId && roles.has(userId) ? { role: roles.get(userId) } : null,
    }
    const module = await Test.createTestingModule({
      controllers: [CouponClaimsController],
      providers: [
        CouponClaimsService,
        { provide: JwtStrategy, useValue: jwt },
        { provide: UserService, useValue: users },
        { provide: TypedConfigService, useValue: config },
        // PostgreSQL UUID lookups return the canonical lowercase ID for either spelling.
        { provide: OrganizationService, useValue: { findOne: (id: string) => ({ id: id.toLowerCase() }) } },
        { provide: OrganizationUserService, useValue: membership },
        { provide: getRedisConnectionToken(), useValue: cache },
      ],
    })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0, '127.0.0.1')
    endpoint = await app.getUrl()
  })

  beforeEach(() => {
    deliveries.length = 0
    cache.clear()
    roles.set('owner', OrganizationMemberRole.OWNER)
    roles.set('member', OrganizationMemberRole.MEMBER)
    roles.set('unverified', OrganizationMemberRole.OWNER)
    roles.set('admin', OrganizationMemberRole.OWNER)
    commerceReply = { status: 202, body: receipt }
    Object.assign(settings, {
      billingApiUrl: `${upstream}/api/billing`,
      'usageExport.url': `${upstream}/gateway`,
      'usageExport.token': serviceToken,
    })
  })

  afterAll(async () => {
    await app?.close()
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function post(body: unknown = claim, token: string | null = tokens.owner, org: string = organizationId) {
    return axios.post(`${endpoint}/api/organizations/${org}/coupon-claims`, body, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
      proxy: false,
    })
  }

  it('submits the selected organization and exact event envelope with the Commerce service token', async () => {
    const before = Date.now()
    const response = await post()
    expect(response.status).toBe(202)
    expect(response.data).toEqual({ status: 'pending', result: null })
    expect(deliveries).toEqual([
      {
        method: 'POST',
        path: `/gateway/internal/organization/${organizationId}/billing-events`,
        authorization: `Bearer ${serviceToken}`,
        body: {
          eventId: claim.eventId,
          type: 'RedeemCouponAfterBindCard',
          occurredAt: expect.stringMatching(/T.+(?:Z|[+-]\d{2}:\d{2})$/),
          data: { coupon_code: claim.couponCode },
        },
      },
    ])
    const occurredAt = Date.parse(deliveries[0].body.occurredAt as string)
    expect(occurredAt).toBeGreaterThanOrEqual(before)
    expect(occurredAt).toBeLessThanOrEqual(Date.now())
  })

  it.each([
    ['pending', null],
    ['done', credited],
    ['done', { outcome: 'skipped', reason: 'coupon_exhausted' }],
    ['failed', null],
  ])('returns a replayed %s receipt with its saved result %j', async (status, result) => {
    commerceReply = { status: 202, body: { ...receipt, status, result, replayed: true } }
    const response = await post()
    expect(response.status).toBe(202)
    expect(response.data).toEqual({ status, result })
  })

  it('uses the resolved organization UUID for Commerce when the route uses uppercase', async () => {
    const response = await post(claim, tokens.owner, organizationId.toUpperCase())
    expect(deliveries.map(({ path }) => path)).toEqual([
      `/gateway/internal/organization/${organizationId}/billing-events`,
    ])
    expect(response.status).toBe(202)
  })

  it.each([
    [404, 'coupon_not_found', 'Coupon not found'],
    [403, 'coupon_wrong_organization', 'This coupon is not available to this organization'],
    [409, 'coupon_already_redeemed', 'Coupon has already been redeemed'],
    [409, 'coupon_disabled', 'This coupon is disabled'],
    [409, 'coupon_expired', 'This coupon is expired'],
    [409, 'coupon_exhausted', 'This coupon is exhausted'],
  ] as const)('preserves Commerce rejection %i %s', async (status, code, message) => {
    commerceReply = { status, body: { code, message } }
    const response = await post()
    expect(response.status).toBe(status)
    expect(response.data).toMatchObject({ code, message })
  })

  it('distinguishes a delivery identity conflict from a coupon rejection', async () => {
    commerceReply = {
      status: 409,
      body: {
        statusCode: 409,
        error: 'Conflict',
        message: 'Billing Event eventId was already accepted with different identity or ownership',
      },
    }
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.data.code).toBe('coupon_claim_conflict')
  })

  it('resolves a lost response by sending the original delivery ID and code on retry', async () => {
    const receipts = new Map<string, Omit<typeof receipt, 'result'> & { result: typeof credited | null }>()
    commerceReply = ({ path, body }) => {
      const identity = JSON.stringify([path, body.eventId, body.type, body.data])
      const saved = receipts.get(identity)
      if (!saved) {
        receipts.set(identity, { ...receipt, billingEventId: randomUUID() })
        return 'disconnect'
      }
      return { status: 202, body: { ...saved, replayed: true } }
    }
    expect((await post()).status).toBe(503)
    expect(receipts.size).toBe(1)
    Object.assign([...receipts.values()][0], { status: 'done', result: credited })
    const replay = await post()
    expect(replay.status).toBe(202)
    expect(replay.data).toEqual({ status: 'done', result: credited })
    expect(receipts.size).toBe(1)
    expect(deliveries.map(({ body }) => [body.eventId, body.data])).toEqual([
      [claim.eventId, { coupon_code: claim.couponCode }],
      [claim.eventId, { coupon_code: claim.couponCode }],
    ])
  })

  it.each([
    [202, { ...receipt, organizationId: otherOrganizationId }],
    [202, { ...receipt, eventId: randomUUID() }],
    [202, { ...receipt, type: 'referral-newer' }],
    [202, { ...receipt, status: 'done', result: null }],
    [202, { ...receipt, status: 'done', result: { outcome: 'processed' } }],
    [400, { statusCode: 400, message: 'Unsupported Billing Event type' }],
    [401, { statusCode: 401, error: 'Unauthorized' }],
    [404, { statusCode: 404, error: 'Not Found' }],
    [500, { message: 'Commit uncertain' }],
  ] as const)('reports unconfirmed acceptance for upstream %i %j', async (status, body) => {
    commerceReply = { status, body }
    expect((await post()).status).toBe(503)
  })

  it('requires a configured service credential before contacting Commerce', async () => {
    delete settings['usageExport.token']
    expect((await post()).status).toBe(503)
    expect(deliveries).toHaveLength(0)
  })

  it.each([
    ['no credentials', null, organizationId, 401],
    ['service token as a dashboard credential', serviceToken, organizationId, 401],
    ['organization member', 'member', organizationId, 403],
    ['owner of a different organization', 'owner', otherOrganizationId, 403],
    ['system administrator without ownership', 'admin', otherOrganizationId, 403],
    ['unverified owner', 'unverified', organizationId, 403],
  ] as const)('rejects %s before contacting Commerce', async (_label, identity, org, expected) => {
    const token = identity === null ? null : tokens[identity] ?? identity
    const response = await post(claim, token, org)
    expect(response.status).toBe(expected)
    if (identity === 'unverified') expect(response.data.code).toBe('email_verification_required')
    expect(deliveries).toHaveLength(0)
  })

  it('accepts a system administrator who owns the target organization', async () => {
    expect((await post(claim, tokens.admin)).status).toBe(202)
    expect(deliveries).toHaveLength(1)
  })

  it.each(['removed', 'demoted'])('denies a cached owner whose membership was %s', async (change) => {
    expect((await post()).status).toBe(202)
    if (change === 'removed') roles.delete('owner')
    else roles.set('owner', OrganizationMemberRole.MEMBER)
    expect((await post()).status).toBe(403)
    expect(deliveries).toHaveLength(1)
  })

  it('accepts the maximum event ID and coupon code lengths', async () => {
    const longest = { eventId: 'e'.repeat(200), couponCode: 'A'.repeat(64) }
    commerceReply = { status: 202, body: { ...receipt, eventId: longest.eventId } }
    expect((await post(longest)).status).toBe(202)
    expect(deliveries[0].body).toMatchObject({ eventId: longest.eventId, data: { coupon_code: longest.couponCode } })
  })

  it.each([
    { couponCode: claim.couponCode },
    { ...claim, eventId: 'has spaces' },
    { ...claim, eventId: 'e'.repeat(201) },
    { eventId: claim.eventId },
    { ...claim, couponCode: 'A/B' },
    { ...claim, couponCode: ' ' },
    { ...claim, couponCode: 'A'.repeat(65) },
    { ...claim, organizationId: otherOrganizationId },
  ])('rejects invalid claim input %j before sending a delivery', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(deliveries).toHaveLength(0)
  })
})
