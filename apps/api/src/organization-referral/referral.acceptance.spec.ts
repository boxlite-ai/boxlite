import { randomUUID } from 'node:crypto'
import { Organization } from '../organization/entities/organization.entity'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { ReferralDatabase } from './test-support/referral-database'
import { ReferralCommerce } from './test-support/referral-commerce'
import { startReferralApi, startTestIdentity, closeServer } from './test-support/referral-http'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { Region } from '../region/entities/region.entity'
import { RegionType } from '../region/enums/region-type.enum'
import { UserRegistration } from '../user/user-registration.entity'
import { BusinessEventOutbox } from '../business-events/business-event-outbox.entity'
import { BusinessEventPublisherService } from '../business-events/business-event-publisher.service'
import { businessEventsConfig } from '../business-events/business-events.config'

jest.setTimeout(180000)

describe('X01–X06: BoxLite and real Commerce, M=137 cents, N=2', () => {
  const fixture = new ReferralDatabase()
  const commerce = new ReferralCommerce()
  const evidence: Record<string, unknown>[] = []
  let database: DataSource
  let identity: Awaited<ReturnType<typeof startTestIdentity>>
  let api: Awaited<ReturnType<typeof startReferralApi>>
  const zero = { events: 0, coupons: 0, redemptions: 0, wallets: 0, movements: 0, granted: 0 }
  const worker = (url = commerce.url, enabled = true) =>
    new BusinessEventPublisherService(database, {
      getOrThrow: () =>
        businessEventsConfig({
          BUSINESS_EVENTS_ENABLED: String(enabled),
          USAGE_EXPORT_URL: url,
          USAGE_EXPORT_TOKEN: commerce.token,
        }),
    } as never)
  const queued = (eventId: string) => database.getRepository(BusinessEventOutbox).findOneByOrFail({ eventId })
  async function inviter() {
    const subject = 'cross-inviter-' + randomUUID()
    await api.users.create({ id: subject, name: 'Cross-repository inviter', emailVerified: true })
    const organization = await api.organizations.findDefaultForUser(subject)
    return { subject, organization, code: (await api.referrals.getCode(organization.id)).referralCode }
  }
  async function register(code?: string, subject = 'cross-invitee-' + randomUUID()) {
    const response = await fetch(api.url + '/api/organizations' + (code ? '?referredCode=' + code : ''), {
      headers: { Authorization: 'Bearer ' + (await identity.token(subject)) },
      signal: AbortSignal.timeout(15000),
    })
    expect(response.status).toBe(200)
    expect(Array.isArray(await response.json())).toBe(true)
    const registration = await database.getRepository(UserRegistration).findOneByOrFail({ userId: subject })
    const organization = await database
      .getRepository(Organization)
      .findOneByOrFail({ id: registration.defaultOrganizationId })
    expect(organization.inviterOrganizationId).toBe(registration.inviterOrganizationId)
    expect(organization.referredCode).toBe(registration.referredCode)
    return registration
  }
  async function record(caseId: string, organizationId: string, registrations: UserRegistration[] = []) {
    const events = await Promise.all(registrations.filter((r) => r.eventId).map((r) => queued(r.eventId)))
    const rewards = await commerce.rewardIds(organizationId)
    for (const event of events) {
      if (event.responseSnapshot?.outcome === 'processed') {
        const result = event.responseSnapshot.result as Record<string, unknown>
        expect(rewards).toContainEqual({
          couponId: result.couponId,
          redemptionId: result.redemptionId,
          walletTransactionId: result.walletTransactionId,
          creditCents: result.creditCents,
        })
      }
    }
    evidence.push({
      caseId,
      organizationId,
      registrationIds: registrations.map((r) => r.id),
      events,
      ledger: await commerce.ledger(organizationId),
      rewards,
    })
  }

  beforeAll(async () => {
    database = await fixture.initialize()
    await commerce.start()
    identity = await startTestIdentity()
    api = await startReferralApi(await fixture.connect('acceptance-api'), identity.issuer, fixture.name)
    await database.getRepository(Region).save(
      new Region({
        id: 'referral-test',
        name: 'Acceptance region',
        regionType: RegionType.SHARED,
        enforceQuotas: false,
      }),
    )
  })
  afterAll(async () => {
    try {
      await writeFile(
        join(process.env.REFERRAL_REPORT_DIR, 'acceptance-evidence.json'),
        JSON.stringify(
          {
            boxliteDatabase: fixture.name,
            commerceDatabase: commerce.name,
            commerceWorkspace: commerce.workspace,
            commerceRevision: commerce.revision,
            commerceSourceSha256: commerce.sourceSha256,
            rules: { creditCents: 137, maxRewardsPerOrganization: 2 },
            cases: evidence,
            manualRemaining: ['Hosted OIDC and system clipboard', 'Deployment rollback to compatibility builds'],
          },
          null,
          2,
        ),
      )
    } finally {
      await api?.close()
      await identity?.close()
      await commerce.close()
      await fixture.close()
    }
  })

  it('X01: an invitation-link code yields one durable reward with matching ledger IDs', async () => {
    const source = await inviter()
    expect(await commerce.ledger(source.organization.id)).toEqual(zero)
    const registration = await register(source.code)
    expect(registration.status).toBe('accepted')
    const publisher = worker()
    try {
      await publisher.publishOnce()
    } finally {
      await publisher.onApplicationShutdown()
    }
    expect((await queued(registration.eventId)).status).toBe('delivered')
    expect(await commerce.ledger(source.organization.id)).toEqual({
      events: 1,
      coupons: 1,
      redemptions: 1,
      wallets: 1,
      movements: 1,
      granted: 137,
    })
    await record('X01', source.organization.id, [registration])
  })

  it('X02: ordinary registration produces no event, attribution, wallet, or invitation reward', async () => {
    const registration = await register()
    expect(registration).toMatchObject({ status: 'none', eventId: null, referredCode: null })
    const publisher = worker()
    try {
      await publisher.publishOnce()
    } finally {
      await publisher.onApplicationShutdown()
    }
    expect(await commerce.ledger(registration.defaultOrganizationId)).toEqual(zero)
    await record('X02', registration.defaultOrganizationId, [registration])
  })

  it('X03: an acknowledged Commerce commit with a lost response replays original IDs without another reward', async () => {
    const source = await inviter()
    const registration = await register(source.code)
    const bodies: unknown[] = []
    const relay = createServer(async (request, response) => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString()
        bodies.push(JSON.parse(body))
        const result = await fetch(commerce.url + request.url, {
          method: 'POST',
          headers: { Authorization: request.headers.authorization, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(15000),
        })
        const receipt = await result.text()
        if (bodies.length === 1) request.socket.destroy()
        else {
          response.statusCode = result.status
          response.end(receipt)
        }
      } catch {
        response.statusCode = 503
        response.end('{}')
      }
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    const publisher = worker('http://127.0.0.1:' + (relay.address() as AddressInfo).port)
    try {
      await publisher.publishOnce()
      expect((await queued(registration.eventId)).status).toBe('pending')
      const committed = await commerce.rewardIds(source.organization.id)
      expect(committed).toHaveLength(1)
      await database.getRepository(BusinessEventOutbox).update(registration.eventId, { availableAt: new Date(0) })
      await publisher.publishOnce()
      const result = await queued(registration.eventId)
      expect(result.status).toBe('delivered')
      expect(result.responseSnapshot.replayed).toBe(true)
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toEqual(bodies[0])
      expect(await commerce.rewardIds(source.organization.id)).toEqual(committed)
      expect(await commerce.ledger(source.organization.id)).toEqual({
        events: 1,
        coupons: 1,
        redemptions: 1,
        wallets: 1,
        movements: 1,
        granted: 137,
      })
      await record('X03', source.organization.id, [registration])
    } finally {
      await publisher.onApplicationShutdown()
      await closeServer(relay)
    }
  })

  it('X04: three registrations yield two rewards and a terminal limit receipt', async () => {
    const source = await inviter()
    const registrations: UserRegistration[] = []
    const publisher = worker()
    try {
      for (let index = 0; index < 3; index++) {
        registrations.push(await register(source.code))
        await publisher.publishOnce()
      }
      expect(await commerce.ledger(source.organization.id)).toEqual({
        events: 3,
        coupons: 2,
        redemptions: 2,
        wallets: 1,
        movements: 2,
        granted: 274,
      })
      expect((await queued(registrations[2].eventId)).responseSnapshot).toMatchObject({
        outcome: 'skipped',
        reason: 'reward_limit_reached',
        result: null,
      })
      expect((await queued(registrations[2].eventId)).status).toBe('delivered')
      await record('X04', source.organization.id, registrations)
    } finally {
      await publisher.onApplicationShutdown()
    }
  })

  it('X05: a normal member shares without a wallet read; the first reward creates exactly one default wallet', async () => {
    const source = await inviter()
    const member = 'cross-member-' + randomUUID()
    await api.users.create({ id: member, name: 'Member', emailVerified: true })
    await database
      .getRepository(OrganizationUser)
      .insert({ organizationId: source.organization.id, userId: member, role: OrganizationMemberRole.MEMBER })
    expect(await commerce.ledger(source.organization.id)).toEqual(zero)
    const response = await fetch(api.url + '/api/organizations/' + source.organization.id + '/referral-code', {
      headers: { Authorization: 'Bearer ' + (await identity.token(member)) },
      signal: AbortSignal.timeout(15000),
    })
    expect(response.status).toBe(200)
    const code = (await response.json()).referralCode
    expect(await commerce.ledger(source.organization.id)).toEqual(zero)
    const registration = await register(code)
    const publisher = worker()
    try {
      await publisher.publishOnce()
    } finally {
      await publisher.onApplicationShutdown()
    }
    expect(await commerce.ledger(source.organization.id)).toEqual({
      events: 1,
      coupons: 1,
      redemptions: 1,
      wallets: 1,
      movements: 1,
      granted: 137,
    })
    const wallets = await commerce.database.query(
      'SELECT code, balance_cents::int AS balance FROM commerce_wallets WHERE organization_id = $1',
      [source.organization.id],
    )
    expect(wallets).toEqual([{ code: 'default', balance: 137 }])
    await record('X05', source.organization.id, [registration])
  })

  it('X06 automated portion: worker disable/restart retains queued facts and schema rollback refuses active data', async () => {
    const source = await inviter()
    const registration = await register(source.code)
    const before = await queued(registration.eventId)
    const stopped = worker(commerce.url, false)
    await stopped.publishOnce()
    await stopped.onApplicationShutdown()
    expect(await queued(registration.eventId)).toEqual(before)
    expect(await commerce.ledger(source.organization.id)).toEqual(zero)
    await expect(database.undoLastMigration({ transaction: 'all' })).rejects.toThrow('Invitation data exists')
    const replacement = worker()
    try {
      await replacement.publishOnce()
    } finally {
      await replacement.onApplicationShutdown()
    }
    expect((await queued(registration.eventId)).payload).toEqual(before.payload)
    expect((await queued(registration.eventId)).status).toBe('delivered')
    expect(await commerce.ledger(source.organization.id)).toEqual({
      events: 1,
      coupons: 1,
      redemptions: 1,
      wallets: 1,
      movements: 1,
      granted: 137,
    })
    await record('X06-automated', source.organization.id, [registration])
  })
})
