/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import axios from 'axios'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { DataSource } from 'typeorm'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { CancellationFeedbackService } from '../services/cancellation-feedback.service'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { CancellationFeedbackController } from './cancellation-feedback.controller'
import { AddCancellationFeedback1795449600000 } from '../../migrations/pre-deploy/1795449600000-add-cancellation-feedback-migration'
import { OrganizationDto } from '../dto/organization.dto'

const ciDatabase = process.env.CI && process.env.DB_HOST === 'localhost' && process.env.DB_DATABASE === 'boxlite'
const databaseUrl =
  process.env.CANCELLATION_TEST_DATABASE_URL ??
  (ciDatabase ? 'postgres://postgres:postgres@localhost:5432/boxlite' : undefined)
const integration = databaseUrl ? describe : describe.skip
integration('organization cancellation feedback (Postgres and authenticated HTTP)', () => {
  const schema = `cancellation_${randomUUID().replaceAll('-', '')}`
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const feedback = { reasons: ['other', 'pricing', 'other'], intent: 'one_off', note: ' Custom reason ' }
  let db: DataSource
  let app: INestApplication
  let server: Server
  let endpoint: string
  let jwt: JwtStrategy
  const roles = new Map<string, OrganizationMemberRole>()
  const cache = new Map<string, string>()
  const tokens: Record<string, string> = {}
  const options = () => ({
    type: 'postgres' as const,
    url: databaseUrl,
    entities: [],
    extra: { options: `-c search_path=${schema}` },
  })

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl!).hostname))
      throw new Error('Local disposable database required')
    const setup = await new DataSource({ type: 'postgres', url: databaseUrl, entities: [] }).initialize()
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`)
    } finally {
      await setup.destroy()
    }
    db = await new DataSource(options()).initialize()
    await db.query('CREATE TABLE organization (id uuid PRIMARY KEY, "updatedAt" timestamptz DEFAULT now())')
    await db.query('INSERT INTO organization (id) VALUES ($1), ($2)', [organizationId, otherOrganizationId])
    const runner = db.createQueryRunner()
    try {
      await new AddCancellationFeedback1795449600000().up(runner)
    } finally {
      await runner.release()
    }
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'feedback', alg: 'RS256' }] }
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(jwks))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const users = {
      findOne: (id: string) => ({ id, role: id === 'admin' ? SystemRole.ADMIN : SystemRole.USER, emailVerified: true }),
    }
    jwt = new JwtStrategy(
      { issuer, audience: 'dashboard', jwksUri: `${issuer}/jwks` },
      users as never,
      { get: () => undefined } as never,
      { recordFirstUse: jest.fn() } as never,
    )
    for (const userId of ['owner', 'member', 'outsider', 'admin']) {
      tokens[userId] = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'feedback' })
        .setIssuer(issuer)
        .setAudience('dashboard')
        .setSubject(userId)
        .setExpirationTime('1h')
        .sign(privateKey)
    }
    await startApp()
  })
  async function startApp() {
    const membership = {
      findOne: (org: string, user: string) =>
        org === organizationId && roles.has(user) ? { role: roles.get(user) } : null,
    }
    const module = await Test.createTestingModule({
      controllers: [CancellationFeedbackController],
      providers: [
        CancellationFeedbackService,
        { provide: DataSource, useValue: db },
        { provide: JwtStrategy, useValue: jwt },
        {
          provide: OrganizationService,
          useValue: {
            findOne: async (id: string) => (await db.query('SELECT id FROM organization WHERE id=$1', [id]))[0] ?? null,
          },
        },
        { provide: OrganizationUserService, useValue: membership },
        { provide: getRedisConnectionToken(), useValue: cache },
      ],
    })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0, '127.0.0.1')
    endpoint = await app.getUrl()
  }

  beforeEach(async () => {
    cache.clear()
    roles.clear()
    roles.set('owner', OrganizationMemberRole.OWNER)
    roles.set('member', OrganizationMemberRole.MEMBER)
    await db.query('UPDATE organization SET "cancellationFeedback"=NULL')
  })
  afterAll(async () => {
    await app?.close()
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  function put(body: unknown = feedback, token: string | null = tokens.owner, org = organizationId) {
    return axios.put(`${endpoint}/api/organizations/${org}/cancellation-feedback`, body, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
      proxy: false,
    })
  }
  async function stored(org = organizationId) {
    return (await db.query('SELECT "cancellationFeedback" FROM organization WHERE id=$1', [org]))[0]
      .cancellationFeedback
  }
  it('adds nullable storage, commits normalized answers, and persists across database reconnection', async () => {
    expect(await stored()).toBeNull()
    const before = Date.now()
    const response = await put()
    expect(response.status).toBe(204)
    expect(response.data).toBe('')
    const observer = await new DataSource(options()).initialize()
    try {
      const [row] = await observer.query('SELECT "cancellationFeedback" FROM organization WHERE id=$1', [
        organizationId,
      ])
      expect(row.cancellationFeedback).toEqual({
        reasons: ['other', 'pricing'],
        intent: 'one_off',
        note: 'Custom reason',
        submittedBy: 'owner',
        submittedAt: expect.any(String),
      })
      expect(Date.parse(row.cancellationFeedback.submittedAt)).toBeGreaterThanOrEqual(before)
    } finally {
      await observer.destroy()
    }
    expect(await stored(otherOrganizationId)).toBeNull()
  })
  it('replaces the latest feedback without adding rows and does not expose it in the organization DTO', async () => {
    expect((await put()).status).toBe(204)
    const next = { reasons: ['completed'], intent: null, note: '' }
    expect((await put(next)).status).toBe(204)
    expect((await put(next)).status).toBe(204)
    expect(await stored()).toMatchObject(next)
    expect(Number((await db.query('SELECT count(*) FROM organization'))[0].count)).toBe(2)
    const dto = OrganizationDto.fromOrganization({ id: organizationId, cancellationFeedback: await stored() } as never)
    expect(dto).not.toHaveProperty('cancellationFeedback')
  })
  it.each(['member', 'outsider', 'admin'])('denies %s without modifying feedback', async (user) => {
    expect((await put(feedback, tokens[user])).status).toBe(403)
    expect(await stored()).toBeNull()
  })
  it('denies unauthenticated, invalid-token and foreign-organization requests', async () => {
    expect((await put(feedback, null)).status).toBe(401)
    expect((await put(feedback, 'api-key-not-a-jwt')).status).toBe(401)
    expect((await put(feedback, tokens.owner, otherOrganizationId)).status).toBe(403)
    expect(await stored(otherOrganizationId)).toBeNull()
  })
  it('checks current ownership even when the access guard cached an owner', async () => {
    expect((await put()).status).toBe(204)
    roles.set('owner', OrganizationMemberRole.MEMBER)
    expect((await put({ reasons: ['completed'] })).status).toBe(403)
    expect((await stored()).reasons).toEqual(['other', 'pricing'])
  })
  it.each([
    { reasons: [] },
    { reasons: ['invalid'] },
    { reasons: 'pricing' },
    { reasons: Array(12).fill('other') },
    { reasons: ['other'], note: 'x'.repeat(1001) },
    { reasons: ['pricing'], note: 'private text' },
    { reasons: ['pricing'], intent: 'invalid' },
    { reasons: ['pricing'], submittedBy: 'forged' },
    { reasons: ['pricing'], submittedAt: '2026-01-01' },
  ])('rejects invalid feedback without echoing answers: %p', async (body) => {
    const response = await put(body)
    expect(response.status).toBe(400)
    expect(response.data.message).toBe('Expected valid cancellation reasons, intent and optional note')
    expect(await stored()).toBeNull()
  })
  it('accepts the text boundary and treats SQL-looking text only as data', async () => {
    expect((await put({ reasons: ['other'], note: 'x'.repeat(1000) })).status).toBe(204)
    expect((await stored()).note).toHaveLength(1000)
    const note = "'); DROP TABLE organization; --"
    expect((await put({ reasons: ['other'], note })).status).toBe(204)
    expect((await stored()).note).toBe(note)
  })
  it('does not return saved when the organization was removed before its UPDATE', async () => {
    const service = new CancellationFeedbackService(db)
    await expect(service.save(randomUUID(), 'owner', { reasons: ['pricing'], intent: null, note: '' })).rejects.toThrow(
      'Organization not found',
    )
  })
  it('retains accepted feedback after stopping and restarting the API and its database connection', async () => {
    expect((await put()).status).toBe(204)
    const previous = await stored()
    await app.close()
    await db.destroy()
    db = await new DataSource(options()).initialize()
    await startApp()
    expect(await stored()).toEqual(previous)
    expect((await put({ reasons: ['completed'] })).status).toBe(204)
    expect((await stored()).reasons).toEqual(['completed'])
  })
})
