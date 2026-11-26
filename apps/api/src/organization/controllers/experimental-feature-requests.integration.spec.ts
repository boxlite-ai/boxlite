/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Logger, LoggerModule } from 'nestjs-pino'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { swapMessageAndObject } from '../../common/utils/pino.util'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { ExperimentalFeatureRequestsController } from './experimental-feature-requests.controller'

// Jest's module registry bypasses the Pino require hook installed in tracing.ts.
jest.mock('pino', () => {
  const { PinoInstrumentation } = jest.requireActual('@opentelemetry/instrumentation-pino')
  const [definition] = new PinoInstrumentation().getModuleDefinitions()
  return definition.patch(jest.requireActual('pino'), jest.requireActual('pino/package.json').version)
})

describe('organization experimental feature requests', () => {
  const organizationId = 'abcde000-0000-4000-8000-000000000001'
  const exporter = new InMemoryLogRecordExporter()
  const requests = () =>
    exporter.getFinishedLogRecords().filter((log) => log.attributes['event.name'] === 'experimental_feature.requested')
  let app: INestApplication
  let server: Server
  let endpoint: string
  let jwt: string
  let email: string

  beforeAll(async () => {
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] }))
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'dashboard', alg: 'RS256' }] }
    server = createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwks)),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const strategy = new JwtStrategy(
      { issuer, audience: 'dashboard', jwksUri: issuer },
      { findOne: (id: string) => ({ id, email, role: SystemRole.USER, emailVerified: true }) } as never,
      { get: () => undefined } as never,
      { recordFirstUse: jest.fn() } as never,
    )
    jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'dashboard' })
      .setIssuer(issuer)
      .setAudience('dashboard')
      .setSubject('member')
      .setExpirationTime('1h')
      .sign(privateKey)
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() })
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: [{ level: 'warn', hooks: { logMethod: swapMessageAndObject } }, sink] }),
      ],
      controllers: [ExperimentalFeatureRequestsController],
      providers: [
        { provide: JwtStrategy, useValue: strategy },
        {
          provide: OrganizationService,
          useValue: { findOne: (id: string) => ({ id: id.toLowerCase(), appHostingPermissions: [] }) },
        },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: (org: string, user: string) =>
              org.toLowerCase() === organizationId && user === 'member'
                ? { role: OrganizationMemberRole.MEMBER }
                : null,
          },
        },
        { provide: getRedisConnectionToken(), useValue: new Map() },
      ],
    })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.useLogger(app.get(Logger))
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    endpoint = await app.getUrl()
  })

  beforeEach(() => {
    email = 'member@example.test'
    exporter.reset()
  })

  afterAll(async () => {
    await app?.close()
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    logs.disable()
  })

  function post(body: unknown, org = organizationId, token: string | null = jwt) {
    return fetch(`${endpoint}/api/organizations/${org}/experimental-feature-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  }

  it.each(['App Hosting', 'Build Insights'])(
    'accepts %s from an uninvited member and exports one structured WARN',
    async (feature) => {
      const before = Date.now()
      const reply = await post({ feature }, organizationId.toUpperCase())
      expect(reply.status).toBe(204)
      expect(await reply.text()).toBe('')
      expect(requests()).toHaveLength(1)
      const [event] = requests()
      expect(event.severityNumber).toBe(SeverityNumber.WARN)
      expect(event.body).toBe(
        `member@example.test is requesting access to the experimental feature ${feature} for organization ${organizationId}.`,
      )
      expect(event.attributes).toMatchObject({
        'organization.id': organizationId,
        'user.id': 'member',
        'user.email': email,
        'feature.name': feature,
      })
      const timestamp = event.attributes['event.timestamp'] as string
      expect(timestamp).toMatch(/Z$/)
      expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now())
    },
  )

  it.each([
    {},
    { feature: ' ' },
    { feature: 'first\nsecond' },
    { feature: 'a'.repeat(81) },
    { feature: 'App Hosting', email: 'another@example.test' },
  ])('rejects invalid body %j without recording a request', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(requests()).toHaveLength(0)
  })

  it('rejects anonymous callers, API keys and users outside the selected organization', async () => {
    const body = { feature: 'App Hosting' }
    expect((await post(body, organizationId, null)).status).toBe(401)
    expect((await post(body, organizationId, 'opaque-organization-api-key')).status).toBe(401)
    expect((await post(body, 'abcde000-0000-4000-8000-000000000002')).status).toBe(403)
    expect(requests()).toHaveLength(0)
  })

  it('requires a contact email on the account', async () => {
    email = ''
    expect((await post({ feature: 'App Hosting' })).status).toBe(422)
    expect(requests()).toHaveLength(0)
  })
})
