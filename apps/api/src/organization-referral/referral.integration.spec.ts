import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DataSource, QueryRunner } from 'typeorm'
import { ReferralDatabase } from './test-support/referral-database'
import { startReferralApi, startTestIdentity, closeServer } from './test-support/referral-http'
import { User } from '../user/user.entity'
import { UserRegistration, RegistrationStatus } from '../user/user-registration.entity'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { Region } from '../region/entities/region.entity'
import { RegionType } from '../region/enums/region-type.enum'
import { BusinessEventOutbox } from '../business-events/business-event-outbox.entity'
import { BusinessEventPublisherService } from '../business-events/business-event-publisher.service'
import { businessEventsConfig } from '../business-events/business-events.config'
import { SystemRole } from '../user/enums/system-role.enum'
import { RegistrationException } from './referral-code'

jest.setTimeout(120000)

describe('Invitation referral — actual migrations, signed JWT HTTP, PostgreSQL and Redis', () => {
  const fixture = new ReferralDatabase()
  let database: DataSource
  let identity: Awaited<ReturnType<typeof startTestIdentity>>
  let first: Awaited<ReturnType<typeof startReferralApi>>
  let second: Awaited<ReturnType<typeof startReferralApi>>
  let inviter: Organization
  let inviterToken: string
  let code: string

  const registration = (userId: string) => database.getRepository(UserRegistration).findOneBy({ userId })
  async function list(userId: string, referredCode?: string, verified = true, api = first) {
    const token = await identity.token(userId, verified)
    return fetch(
      api.url +
        '/api/organizations' +
        (referredCode === undefined ? '' : '?referredCode=' + encodeURIComponent(referredCode)),
      {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(15000),
      },
    )
  }
  async function waitForBlocked(count: number) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const [row] = await database.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
        [fixture.name],
      )
      if (row.count >= count) return
      await nextTurn()
    }
    throw new Error('Expected overlapping blocked PostgreSQL sessions did not appear')
  }
  async function lockSubject(id: string): Promise<QueryRunner> {
    const lock = database.createQueryRunner()
    await lock.connect()
    await lock.startTransaction()
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['user-registration:' + id])
    return lock
  }
  async function release(lock: QueryRunner) {
    await lock.rollbackTransaction()
    await lock.release()
  }

  beforeAll(async () => {
    database = await fixture.initialize()
    // D01/D04: both feature migrations can down/up only before they contain data.
    await database.undoLastMigration({ transaction: 'all' })
    await database.undoLastMigration({ transaction: 'all' })
    const legacyOrganizationId = randomUUID()
    await database.query('INSERT INTO organization (id, name, "createdBy") VALUES ($1, $2, $3)', [
      legacyOrganizationId,
      'Pre-feature organization',
      'pre-feature-user',
    ])
    await database.query('INSERT INTO "user" (id, name, "publicKeys") VALUES ($1, $2, $3)', [
      'pre-feature-user',
      'Pre-feature user',
      '[]',
    ])
    await database.query(
      'INSERT INTO organization_user ("organizationId", "userId", role, "isDefaultForUser") VALUES ($1, $2, $3, true)',
      [legacyOrganizationId, 'pre-feature-user', 'owner'],
    )
    await database.runMigrations({ transaction: 'all' })
    expect(await database.getRepository(Organization).findOneByOrFail({ id: legacyOrganizationId })).toMatchObject({
      referralCode: null,
      referredCode: null,
      inviterOrganizationId: null,
    })
    expect(await registration('pre-feature-user')).toMatchObject({
      defaultOrganizationId: legacyOrganizationId,
      status: 'none',
      referredCode: null,
      eventId: null,
      inviterOrganizationId: null,
    })
    await database.getRepository(Region).save(
      new Region({
        id: 'referral-test',
        name: 'Referral test',
        regionType: RegionType.SHARED,
        enforceQuotas: false,
      }),
    )
    identity = await startTestIdentity()
    first = await startReferralApi(await fixture.connect('api1'), identity.issuer, fixture.name)
    second = await startReferralApi(await fixture.connect('api2'), identity.issuer, fixture.name)
    await first.users.create({ id: 'inviter', name: 'Inviter', emailVerified: true })
    inviter = await first.organizations.findDefaultForUser('inviter')
    code = (await first.referrals.getCode(inviter.id)).referralCode
    inviterToken = await identity.token('inviter')
    await writeFile(
      join(process.env.REFERRAL_REPORT_DIR, 'integration-environment.json'),
      JSON.stringify(
        {
          database: fixture.name,
          redisPrefix: fixture.name,
          issuer: identity.issuer,
          apiInstances: [first.url, second.url],
          concurrencyBarrier: 'pg_stat_activity + pg_blocking_pids',
        },
        null,
        2,
      ),
    )
  })

  afterAll(async () => {
    await first?.close()
    await second?.close()
    await identity?.close()
    await fixture.close()
  })

  it('D02/C01: nullable unique codes; owner/member/admin access, outsiders and service identities denied', async () => {
    const member = 'member-' + randomUUID()
    await first.users.create({ id: member, name: 'Member', emailVerified: true })
    await database
      .getRepository(OrganizationUser)
      .insert({ organizationId: inviter.id, userId: member, role: OrganizationMemberRole.MEMBER })
    const admin = 'admin-' + randomUUID()
    await first.users.create({ id: admin, name: 'Admin', role: SystemRole.ADMIN, emailVerified: true })
    for (const subject of ['inviter', member, admin]) {
      const response = await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
        headers: { Authorization: 'Bearer ' + (await identity.token(subject)) },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ organizationId: inviter.id, referralCode: code })
    }
    const outsider = await identity.token('outsider-' + randomUUID())
    expect(
      (
        await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
          headers: { Authorization: 'Bearer ' + outsider },
        })
      ).status,
    ).toBe(403)
    expect((await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code')).status).toBe(401)
    const memberKey = await first.apiKeys.createApiKey(inviter.id, member, 'share', [])
    expect(
      (
        await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
          headers: { Authorization: 'Bearer ' + memberKey.value },
        })
      ).status,
    ).toBe(200)
    const otherOrganization = await first.organizations.findDefaultForUser(member)
    const wrongScope = await first.apiKeys.createApiKey(otherOrganization.id, member, 'other-scope', [])
    expect(
      (
        await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
          headers: { Authorization: 'Bearer ' + wrongScope.value },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
          headers: { Authorization: 'Bearer referral-fixture-proxy' },
        })
      ).status,
    ).toBe(403)
    const invalidId = await fetch(first.url + '/api/organizations/not-a-uuid/referral-code', {
      headers: { Authorization: 'Bearer ' + inviterToken },
    })
    expect(invalidId.status).toBe(400)
    expect(invalidId.headers.get('cache-control')).toBe('private, no-store')
    await expect(
      database.getRepository(Organization).insert({ name: 'Duplicate code', createdBy: 'inviter', referralCode: code }),
    ).rejects.toMatchObject({ driverError: { code: '23505' } })
  })

  it('C02: 20 overlapping requests on two API instances initialize one organization code', async () => {
    const organization = await database
      .getRepository(Organization)
      .save({ name: 'Concurrent code', createdBy: 'inviter' })
    await database
      .getRepository(OrganizationUser)
      .insert({ organizationId: organization.id, userId: 'inviter', role: OrganizationMemberRole.MEMBER })
    const lock = database.createQueryRunner()
    await lock.connect()
    await lock.startTransaction()
    await lock.query('SELECT id FROM organization WHERE id = $1 FOR UPDATE', [organization.id])
    let calls: Promise<Response>[]
    try {
      calls = Array.from({ length: 20 }, (_, i) =>
        fetch((i % 2 ? first : second).url + '/api/organizations/' + organization.id + '/referral-code', {
          headers: { Authorization: 'Bearer ' + inviterToken },
          signal: AbortSignal.timeout(20000),
        }),
      )
      await waitForBlocked(2)
    } finally {
      await release(lock)
    }
    const responses = await Promise.all(calls)
    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200))
    const payloads = await Promise.all(responses.map((r) => r.json()))
    expect(new Set(payloads.map((p) => p.referralCode)).size).toBe(1)
    expect(payloads[0].referralCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
  })

  it('C03: collision savepoints retry only the referral unique constraint and stop at five', async () => {
    const target = await database.getRepository(Organization).save({ name: 'Collision', createdBy: 'inviter' })
    const generator = jest.spyOn(first.referrals as any, 'generateCode').mockReturnValue(code)
    try {
      await expect(first.referrals.getCode(target.id)).rejects.toMatchObject({
        response: { code: 'referral_code_unavailable' },
      })
      expect(generator).toHaveBeenCalledTimes(5)
      generator.mockReturnValueOnce(code).mockReturnValueOnce('ABCDEFGH23')
      expect((await first.referrals.getCode(target.id)).referralCode).toBe('ABCDEFGH23')
      const invalid = await database
        .getRepository(Organization)
        .save({ name: 'Invalid generated value', createdBy: 'inviter' })
      generator.mockReset().mockReturnValue('X'.repeat(11))
      await expect(first.referrals.getCode(invalid.id)).rejects.toMatchObject({ driverError: { code: '22001' } })
      expect(generator).toHaveBeenCalledTimes(1)
    } finally {
      generator.mockRestore()
    }
  })

  it('C04: referral-code row lock times out without changing the saved code', async () => {
    const lock = database.createQueryRunner()
    await lock.connect()
    await lock.startTransaction()
    await lock.query('SELECT id FROM organization WHERE id = $1 FOR UPDATE', [inviter.id])
    try {
      const response = await fetch(first.url + '/api/organizations/' + inviter.id + '/referral-code', {
        headers: { Authorization: 'Bearer ' + inviterToken },
        signal: AbortSignal.timeout(15000),
      })
      expect(response.status).toBe(503)
      expect((await response.json()).code).toBe('referral_code_unavailable')
    } finally {
      await release(lock)
    }
    expect((await first.referrals.getCode(inviter.id)).referralCode).toBe(code)
  })

  it('R01/E01: verified link registration atomically creates one accepted fact and exact event payload', async () => {
    const subject = 'accepted-' + randomUUID()
    const response = await list(subject, code.toLowerCase())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const organizations = await response.json()
    expect(Array.isArray(organizations)).toBe(true)
    const record = await registration(subject)
    expect(record.status).toBe(RegistrationStatus.ACCEPTED)
    expect(organizations[0].id).toBe(record.defaultOrganizationId)
    const org = await database.getRepository(Organization).findOneByOrFail({ id: record.defaultOrganizationId })
    expect(org.referredCode).toBe(code)
    expect(org.inviterOrganizationId).toBe(inviter.id)
    expect(record.inviterOrganizationId).toBe(org.inviterOrganizationId)
    const queued = await database.getRepository(BusinessEventOutbox).findOneByOrFail({ eventId: record.eventId })
    expect(queued.organizationId).toBe(inviter.id)
    expect(queued.payload).toEqual({
      eventId: record.eventId,
      type: 'InvitationRegistrationSucceeded',
      occurredAt: record.acceptedAt.toISOString(),
      data: { registrationId: record.id, inviteeUserId: subject },
    })
    expect(queued.status).toBe('pending')
  })

  it('R01/R02: ordinary registration stays none; malformed/unavailable codes and unverified Auth0 leave no local rows', async () => {
    const ordinary = 'ordinary-' + randomUUID()
    expect((await list(ordinary)).status).toBe(200)
    expect((await registration(ordinary)).status).toBe('none')
    const cases = [
      ['?referredCode=bad', 400, 'social-'],
      ['?referredCode=ABCD2345EF&referredCode=ABCD2345EF', 400, 'social-'],
      ['?referredCode%5Bx%5D=ABCD2345EF', 400, 'social-'],
      ['?referredCode=ZZZZZZZZZZ', 422, 'social-'],
      ['?referredCode=' + code, 403, 'auth0|'],
    ] as const
    for (const [query, status, prefix] of cases) {
      const subject = prefix + randomUUID()
      const response = await fetch(first.url + '/api/organizations' + query, {
        headers: { Authorization: 'Bearer ' + (await identity.token(subject, false)) },
      })
      expect(response.status).toBe(status)
      expect(await database.getRepository(User).findOneBy({ id: subject })).toBeNull()
      expect(await registration(subject)).toBeNull()
    }
  })

  it('R03/R04: overlapping same-code and conflicting-code requests share the subject transaction boundary', async () => {
    const subject = 'race-' + randomUUID()
    const lock = await lockSubject(subject)
    let a: Promise<Response>, b: Promise<Response>
    try {
      a = list(subject, code, true, first)
      b = list(subject, 'ABCDEFGH23', true, second)
      await waitForBlocked(2)
    } finally {
      await release(lock)
    }
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    const record = await registration(subject)
    expect((await list(subject, record.referredCode)).status).toBe(200)
    expect((await registration(subject)).eventId).toBe(record.eventId)
    expect(await database.getRepository(BusinessEventOutbox).countBy({ eventId: record.eventId })).toBe(1)
  })

  it('R03: 20 overlapping same-code registrations create exactly one default organization and event', async () => {
    const subject = 'same-code-' + randomUUID()
    const lock = await lockSubject(subject)
    let calls: Promise<Response>[]
    try {
      calls = Array.from({ length: 20 }, (_, i) => list(subject, code, true, i % 2 ? first : second))
      await waitForBlocked(2)
    } finally {
      await release(lock)
    }
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual(Array(20).fill(200))
    const record = await registration(subject)
    expect(await database.getRepository(Organization).countBy({ createdBy: subject })).toBe(1)
    expect(await database.getRepository(BusinessEventOutbox).countBy({ eventId: record.eventId })).toBe(1)
  })

  it('R02: JWT signatures are verified and finalized ordinary registrations cannot be rebound', async () => {
    const subject = 'signature-' + randomUUID()
    const token = await identity.token(subject)
    const [header, payload, signature] = token.split('.')
    const forged = header + '.' + payload + '.' + (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1)
    expect(
      (
        await fetch(first.url + '/api/organizations?referredCode=' + code, {
          headers: { Authorization: 'Bearer ' + forged },
        })
      ).status,
    ).toBe(401)
    expect(await registration(subject)).toBeNull()
    expect((await list(subject)).status).toBe(200)
    expect((await list(subject, code)).status).toBe(409)
    expect((await registration(subject)).status).toBe('none')
  })

  it('E04: confirmation failure rolls verification, unsuspension and acceptance back together', async () => {
    const subject = 'verification-rollback-' + randomUUID()
    await list(subject, code, false)
    const failures = [first, second].map((api) =>
      jest.spyOn(api.outbox, 'enqueue').mockRejectedValueOnce(new Error('Confirmation enqueue failure')),
    )
    try {
      expect((await list(subject, undefined, true)).status).toBe(500)
    } finally {
      failures.forEach((failure) => failure.mockRestore())
    }
    const record = await registration(subject)
    expect(record.status).toBe('pending_verification')
    expect(record.eventId).toBeNull()
    expect((await database.getRepository(User).findOneByOrFail({ id: subject })).emailVerified).toBe(false)
    expect(
      (await database.getRepository(Organization).findOneByOrFail({ id: record.defaultOrganizationId })).suspended,
    ).toBe(true)
    expect((await list(subject, undefined, true)).status).toBe(200)
    expect((await registration(subject)).status).toBe('accepted')
  })

  it('E05: accepted facts survive an unavailable inviter and second organization creation emits no reward', async () => {
    const subject = 'accepted-stable-' + randomUUID()
    await list(subject, code)
    const record = await registration(subject)
    await database.getRepository(Organization).update(inviter.id, { suspended: true })
    try {
      expect((await list(subject, code)).status).toBe(200)
      expect((await registration(subject)).eventId).toBe(record.eventId)
    } finally {
      await database.getRepository(Organization).update(inviter.id, { suspended: false })
    }
    const before = await database.getRepository(BusinessEventOutbox).count()
    await first.organizations.create({ name: 'Second organization' }, subject)
    expect(await database.getRepository(BusinessEventOutbox).count()).toBe(before)
  })

  it('R04/R05: admin and JIT creation contend on the same lock; arbitrary routes/headers cannot bind codes', async () => {
    const subject = 'admin-race-' + randomUUID()
    const lock = await lockSubject(subject)
    let admin: Promise<unknown>, http: Promise<Response>
    try {
      admin = first.users.create({ id: subject, name: 'Admin-created', emailVerified: true }).catch((error) => error)
      http = list(subject, code, true, second)
      await waitForBlocked(2)
    } finally {
      await release(lock)
    }
    const [created, jitResponse] = await Promise.all([admin, http])
    if (!(created instanceof User)) {
      expect(created).toBeInstanceOf(RegistrationException)
      expect((created as RegistrationException).getStatus()).toBe(409)
    }
    expect(jitResponse.status).toBe(created instanceof User ? 409 : 200)
    expect(await database.getRepository(User).countBy({ id: subject })).toBe(1)
    expect(await database.getRepository(UserRegistration).countBy({ userId: subject })).toBe(1)
    const probe = 'probe-' + randomUUID()
    const response = await fetch(first.url + '/api/probe?referredCode=' + code, {
      headers: { Authorization: 'Bearer ' + (await identity.token(probe)), 'x-referred-code': code },
    })
    expect(response.status).toBe(200)
    expect((await registration(probe)).status).toBe('none')
  })

  it('R06/E04: enqueue failure rolls back user, organization, registration and event together', async () => {
    const subject = 'rollback-' + randomUUID()
    const failures = [first, second].map((api) =>
      jest.spyOn(api.outbox, 'enqueue').mockRejectedValueOnce(new Error('Injected enqueue failure')),
    )
    try {
      expect((await list(subject, code)).status).toBe(500)
    } finally {
      failures.forEach((failure) => failure.mockRestore())
    }
    expect(await registration(subject)).toBeNull()
    expect(await database.getRepository(User).findOneBy({ id: subject })).toBeNull()
    expect(await database.getRepository(Organization).countBy({ createdBy: subject })).toBe(0)
    expect((await list(subject, code)).status).toBe(200)
    const accepted = await registration(subject)
    expect((await list(subject, code)).status).toBe(200)
    expect((await registration(subject)).eventId).toBe(accepted.eventId)
  })

  it('E02/E03/E06: pending verification rechecks the saved inviter on refresh, accepts once after recovery', async () => {
    const subject = 'pending-' + randomUUID()
    expect((await list(subject, code, false)).status).toBe(200)
    expect((await registration(subject)).status).toBe('pending_verification')
    await database.getRepository(Organization).update(inviter.id, { suspended: true, suspendedUntil: null })
    try {
      expect((await list(subject, undefined, true)).status).toBe(200)
      expect((await registration(subject)).status).toBe('pending_verification')
    } finally {
      await database.getRepository(Organization).update(inviter.id, { suspended: false })
    }
    expect((await list(subject)).status).toBe(200)
    const accepted = await registration(subject)
    expect(accepted.status).toBe('accepted')
    await first.users.update(subject, { emailVerified: true })
    expect((await list(subject, code)).status).toBe(200)
    expect((await registration(subject)).eventId).toBe(accepted.eventId)
  })

  it('D03/R02: deletion retains immutable attribution; legacy users are recorded none before deletion', async () => {
    const subject = 'deleted-' + randomUUID()
    await list(subject, code)
    const record = await registration(subject)
    await first.users.remove(subject)
    expect((await list(subject, code)).status).toBe(410)
    expect((await registration(subject)).eventId).toBe(record.eventId)
    expect(await database.getRepository(BusinessEventOutbox).countBy({ eventId: record.eventId })).toBe(1)
    const legacy = 'legacy-' + randomUUID()
    await list(legacy)
    await database.getRepository(UserRegistration).delete({ userId: legacy })
    await first.users.remove(legacy)
    expect((await registration(legacy)).status).toBe('none')
    expect((await list(legacy)).status).toBe(410)
  })

  it('D04: down refuses to discard facts after activation', async () => {
    await expect(database.undoLastMigration({ transaction: 'all' })).rejects.toThrow('Invitation data exists')
    expect(await database.getRepository(UserRegistration).count()).toBeGreaterThan(0)
  })

  it('C04/R06: bounded subject lock contention returns registration_busy', async () => {
    const subject = 'busy-' + randomUUID()
    const lock = await lockSubject(subject)
    try {
      const response = await list(subject, code)
      expect(response.status).toBe(503)
      expect((await response.json()).code).toBe('registration_busy')
      expect(await registration(subject)).toBeNull()
    } finally {
      await release(lock)
    }
  })

  describe('P01–P06 durable delivery', () => {
    let server: Server
    let url: string
    let requests: { url: string; authorization?: string; body: any }[]
    let respond: (request: any, response: any, body: any) => void
    const receipt = (body: any, organizationId: string) => ({
      eventId: body.eventId,
      organizationId,
      outcome: 'processed',
      replayed: false,
      reason: null,
      result: {
        scene: 'InvitationReward',
        creditCents: 137,
        couponId: randomUUID(),
        redemptionId: randomUUID(),
        walletTransactionId: randomUUID(),
      },
    })
    const publisher = (changes: Record<string, string> = {}) =>
      new BusinessEventPublisherService(database, {
        get: () => false,
        getOrThrow: () =>
          businessEventsConfig({
            BUSINESS_EVENTS_ENABLED: 'true',
            USAGE_EXPORT_URL: url,
            USAGE_EXPORT_TOKEN: 'fixture-token',
            ...changes,
          }),
      } as never)
    async function event() {
      // Isolate publisher assertions from registrations produced by earlier cases.
      await database.query(
        `UPDATE organization_business_event_outbox SET "availableAt" = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE status = 'pending'`,
      )
      const eventId = randomUUID()
      const payload = {
        eventId,
        type: 'InvitationRegistrationSucceeded' as const,
        occurredAt: new Date().toISOString(),
        data: { registrationId: randomUUID(), inviteeUserId: 'publisher-test' },
      }
      await first.outbox.enqueue(database.manager, inviter.id, payload)
      return database.getRepository(BusinessEventOutbox).findOneByOrFail({ eventId })
    }
    const row = (eventId: string) => database.getRepository(BusinessEventOutbox).findOneByOrFail({ eventId })
    const expire = (eventId: string) =>
      database.getRepository(BusinessEventOutbox).update(eventId, { availableAt: new Date(0) })
    beforeAll(async () => {
      server = createServer(async (request, response) => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        if (chunks.length === 0) {
          response.statusCode = 400
          response.end('{}')
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        requests.push({ url: request.url, authorization: request.headers.authorization, body })
        respond(request, response, body)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    })
    beforeEach(() => {
      requests = []
      respond = (_request, response, body) => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(receipt(body, inviter.id)))
      }
    })
    afterAll(async () => {
      if (server) await closeServer(server)
    })

    it('P01/P06: sends the exact single-event protocol and accepts a matching receipt without wallet calls', async () => {
      const queued = await event()
      await publisher().publishOnce()
      expect(requests).toEqual([
        {
          url: '/internal/organization/' + inviter.id + '/billing-events',
          authorization: 'Bearer fixture-token',
          body: queued.payload,
        },
      ])
      expect((await row(queued.eventId)).status).toBe('delivered')
      expect((await row(queued.eventId)).responseSnapshot.outcome).toBe('processed')
    })
    it.each([400, 401, 409, 413, 429, 500, 503, 202, 200])(
      'P04: HTTP %i follows bounded retry/blocked policy',
      async (status) => {
        const queued = await event()
        respond = (_req, res) => {
          res.statusCode = status
          res.setHeader('Retry-After', '3600')
          res.end('{}')
        }
        await publisher().publishOnce()
        const result = await row(queued.eventId)
        expect(result.status).toBe([400, 401, 409, 413].includes(status) ? 'blocked' : 'pending')
        expect(result.attempts).toBe(1)
        expect(result.availableAt.getTime()).toBeGreaterThan(Date.now() + 3590000)
        expect(result.payload).toEqual(queued.payload)
      },
    )
    it('P02: lost response replays the same immutable event and records replayed receipt', async () => {
      const queued = await event()
      const committed = receipt(queued.payload, inviter.id)
      respond = (req, res) => {
        if (requests.length === 1) req.socket.destroy()
        else res.end(JSON.stringify({ ...committed, replayed: true }))
      }
      await publisher().publishOnce()
      expect((await row(queued.eventId)).status).toBe('pending')
      await expire(queued.eventId)
      await publisher().publishOnce()
      expect(requests[0].body).toEqual(requests[1].body)
      expect((await row(queued.eventId)).responseSnapshot).toEqual({ ...committed, replayed: true })
    })
    it('P01/P04: limit skip is terminal and failures stop at the configured maximum', async () => {
      const skipped = await event()
      respond = (_req, res, body) =>
        res.end(
          JSON.stringify({
            ...receipt(body, inviter.id),
            outcome: 'skipped',
            reason: 'reward_limit_reached',
            result: null,
          }),
        )
      await publisher().publishOnce()
      expect((await row(skipped.eventId)).status).toBe('delivered')
      const failing = await event()
      respond = (_req, res) => {
        res.statusCode = 503
        res.end('{}')
      }
      const worker = publisher({ BUSINESS_EVENTS_MAX_ATTEMPTS: '10' })
      for (let attempt = 0; attempt < 10; attempt++) {
        await expire(failing.eventId)
        await worker.publishOnce()
      }
      expect((await row(failing.eventId)).attempts).toBe(10)
      expect((await row(failing.eventId)).status).toBe('blocked')
    })
    it('P03: an expired worker cannot overwrite a newer claim result', async () => {
      const queued = await event()
      let releaseResponse: () => void
      let arrived: () => void
      const barrier = new Promise<void>((resolve) => {
        arrived = resolve
      })
      respond = (_req, res, body) => {
        if (requests.length === 1) {
          releaseResponse = () => {
            res.statusCode = 401
            res.end('{}')
          }
          arrived()
        } else res.end(JSON.stringify(receipt(body, inviter.id)))
      }
      const old = publisher().publishOnce()
      await barrier
      const oldClaim = (await row(queued.eventId)).claimToken
      await expire(queued.eventId)
      await publisher().publishOnce()
      expect((await row(queued.eventId)).status).toBe('delivered')
      expect(oldClaim).toBeTruthy()
      releaseResponse()
      await old
      expect((await row(queued.eventId)).status).toBe('delivered')
      expect((await row(queued.eventId)).attempts).toBe(0)
    })
    it('P03: two workers honor batch limits and four concurrent sends without double claims', async () => {
      await event()
      await database.query(
        `UPDATE organization_business_event_outbox SET "availableAt" = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE status = 'pending'`,
      )
      const ids: string[] = []
      for (let i = 0; i < 25; i++) {
        const eventId = randomUUID()
        ids.push(eventId)
        await first.outbox.enqueue(database.manager, inviter.id, {
          eventId,
          type: 'InvitationRegistrationSucceeded',
          occurredAt: new Date().toISOString(),
          data: { registrationId: randomUUID(), inviteeUserId: 'batch-' + i },
        })
      }
      const releases: (() => void)[] = []
      let fourArrived: () => void
      const barrier = new Promise<void>((resolve) => {
        fourArrived = resolve
      })
      respond = (_req, res, body) => {
        if (releases.length < 4) {
          releases.push(() => res.end(JSON.stringify(receipt(body, inviter.id))))
          if (releases.length === 4) fourArrived()
        } else res.end(JSON.stringify(receipt(body, inviter.id)))
      }
      const firstBatch = publisher().publishOnce()
      await barrier
      expect(requests).toHaveLength(4)
      try {
        await publisher().publishOnce()
        const [counts] = await database.query(
          `SELECT count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
          count(*) FILTER (WHERE status = 'pending')::int AS pending FROM organization_business_event_outbox
          WHERE "eventId" = ANY($1::uuid[])`,
          [ids],
        )
        expect(counts).toEqual({ delivered: 5, pending: 20 })
      } finally {
        releases.forEach((releaseResponse) => releaseResponse())
      }
      await firstBatch
      expect(requests).toHaveLength(25)
      expect(new Set(requests.map((r) => r.body.eventId)).size).toBe(25)
    })

    it('P04: an HTTP timeout leaves the original event available for a bounded retry', async () => {
      const queued = await event()
      respond = () => undefined
      await publisher({ BUSINESS_EVENTS_TIMEOUT_MS: '100' }).publishOnce()
      expect(await row(queued.eventId)).toMatchObject({ status: 'pending', attempts: 1, payload: queued.payload })
    })

    it('P05: uncommitted events are invisible and shutdown cancels HTTP leaving a recoverable lease', async () => {
      await event()
      await database.query(
        `UPDATE organization_business_event_outbox SET "availableAt" = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE status = 'pending'`,
      )
      const transaction = database.createQueryRunner()
      await transaction.connect()
      await transaction.startTransaction()
      const eventId = randomUUID()
      try {
        await first.outbox.enqueue(transaction.manager, inviter.id, {
          eventId,
          type: 'InvitationRegistrationSucceeded',
          occurredAt: new Date().toISOString(),
          data: { registrationId: randomUUID(), inviteeUserId: 'uncommitted' },
        })
        await publisher().publishOnce()
        expect(requests).toHaveLength(0)
        await transaction.commitTransaction()
      } finally {
        await transaction.release()
      }
      let arrived: () => void
      const barrier = new Promise<void>((resolve) => {
        arrived = resolve
      })
      respond = () => arrived()
      const worker = publisher()
      const inFlight = worker.publishOnce()
      await barrier
      await worker.onApplicationShutdown()
      await inFlight
      expect((await row(eventId)).status).toBe('pending')
      expect((await row(eventId)).claimToken).toBeTruthy()
      respond = (_req, res, body) => res.end(JSON.stringify(receipt(body, inviter.id)))
      await expire(eventId)
      await publisher().publishOnce()
      expect((await row(eventId)).status).toBe('delivered')
    })
  })
})
