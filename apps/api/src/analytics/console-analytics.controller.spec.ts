/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { JwtStrategy } from '../auth/jwt.strategy'
import { ConsoleAnalyticsController } from './console-analytics.controller'
import { AnalyticsConsentService } from './services/analytics-consent.service'
import { AnalyticsService } from './services/analytics.service'

describe('Console analytics HTTP boundary', () => {
  const org = 'a98b01ab-0a84-4b06-955a-2cfacf733f09'
  const capture = jest.fn()
  const decide = jest.fn(async (_id: string, allowed: boolean) => ({ allowed }))
  const consent = {
    decide,
    preference: jest.fn(async () => ({ allowed: true })),
    consolePreference: jest.fn(async () => ({ allowed: true, enabledFrom: null })),
    requireMember: jest.fn(async (id, organization) => {
      if (id !== 'member' || organization !== org) throw new ForbiddenException()
    }),
  }
  const jwks = createServer()
  let app: INestApplication
  let base: string
  let bearer: string
  const request = (path: string, method: string, token?: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
    jwks.on('request', (_req, res) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })),
    )
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r))
    const issuer = 'http://127.0.0.1:' + (jwks.address() as AddressInfo).port + '/'
    const strategy = new JwtStrategy(
      { issuer, audience: 'api', jwksUri: issuer + 'jwks' },
      { findOne: async () => ({ id: 'member', emailVerified: true }) } as never,
      { get: () => undefined } as never,
      { recordFirstUse: async () => {} } as never,
    )
    bearer = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('member')
      .setAudience('api')
      .setIssuer(issuer)
      .setExpirationTime('5m')
      .sign(keys.privateKey)
    const module = await Test.createTestingModule({
      controllers: [ConsoleAnalyticsController],
      providers: [
        { provide: JwtStrategy, useValue: strategy },
        { provide: AnalyticsConsentService, useValue: consent },
        { provide: AnalyticsService, useValue: { capture } },
      ],
    }).compile()
    app = module.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterAll(async () => {
    await app?.close()
    await new Promise<void>((r) => jwks.close(() => r()))
  })
  it('uses the authenticated person and rejects unsupported notice versions and service tokens', async () => {
    for (const credential of [undefined, 'service-api-key']) {
      expect((await request('/analytics/consent', 'PUT', credential, { allowed: true, version: 1 })).status).toBe(401)
    }
    expect((await request('/analytics/consent', 'PUT', bearer, { allowed: true, version: 90 })).status).toBe(400)
    expect(decide).not.toHaveBeenCalled()
    expect(
      (await request('/analytics/consent', 'PUT', bearer, { allowed: false, version: 1, userId: 'outsider' })).status,
    ).toBe(200)
    expect(decide).toHaveBeenCalledWith('member', false)
  })
  it('accepts only known templates and controls for the member’s organization', async () => {
    const events = '/analytics/organizations/' + org + '/console-events'
    const page = { event: '$pageview', page: '/dashboard/boxes', occurredAt: new Date().toISOString() }
    expect((await request(events, 'POST', undefined, page)).status).toBe(401)
    expect(
      (await request(events.replace(org, 'ae7cc449-a06a-43f3-a8db-8a52ff6dfd1e'), 'POST', bearer, page)).status,
    ).toBe(403)
    expect(
      (await request(events, 'POST', bearer, { ...page, page: '/dashboard/boxes/secret?token=secret' })).status,
    ).toBe(400)
    expect((await request(events, 'POST', bearer, { ...page, page: '/dashboard/user/account-settings' })).status).toBe(
      400,
    )
    expect((await request(events, 'POST', bearer, { ...page, event: 'console_control_click' })).status).toBe(400)
    expect(capture).not.toHaveBeenCalled()
    expect(
      (await request(events, 'POST', bearer, { ...page, rawText: 'private', distinctId: 'outsider' })).status,
    ).toBe(204)
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'member', properties: { $pathname: page.page } }),
      { users: ['member'], organizations: [org] },
    )
  })
})
