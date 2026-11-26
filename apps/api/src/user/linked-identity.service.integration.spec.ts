/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationService } from '../organization/services/organization.service'
import { RegistrationService } from '../auth/registration.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { UserEvents } from './constants/user-events.constant'
import { UserCreatedEvent } from './events/user-created.event'
import { randomUUID } from 'node:crypto'
import axios from 'axios'
import type Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { AccountLinkAuth0Reader } from '../auth/account-link-auth0-reader.service'
import { AddAccountLinkCompletionTime1795560002000 } from '../migrations/pre-deploy/1795560002000-add-account-link-completion-time-migration'
import { AddAccountLinkAttempts1795560001000 } from '../migrations/pre-deploy/1795560001000-add-account-link-attempts-migration'
import { AccountLinkConsentJobs } from '../auth/account-link-consent-jobs.service'
import { AccountLinkReconciliation } from '../auth/account-link-reconciliation.service'
import { TypedConfigService } from '../config/typed-config.service'
import { AddAccountLinkConsentJobs1795560000000 } from '../migrations/pre-deploy/1795560000000-add-account-link-consent-jobs-migration'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { apiKeyValidationCacheKey, generateApiKeyHash } from '../common/utils/api-key'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { LinkedIdentityService } from './linked-identity.service'
import { User } from './user.entity'
import { UserService } from './user.service'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { RegistrationConsent } from './registration-consent.entity'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `linked_identity_${process.pid}_${randomUUID().replaceAll('-', '')}`

const PRIMARY = 'auth0|primary'
const SOCIAL = 'google-oauth2|103'

describeIfDatabase('LinkedIdentityService.adopt (integration, real Postgres)', () => {
  let dataSource: DataSource
  let service: LinkedIdentityService
  let jobs: AccountLinkConsentJobs
  const auth0 = { linkExists: jest.fn().mockResolvedValue(false) }
  // The API key cache, which ApiKeyStrategy fills and adopt prunes.
  const cache = new Map<string, string>()
  const redis = {
    del: jest.fn(async (...keys: string[]) => keys.filter((key) => cache.delete(key)).length),
  }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [
        User,
        Organization,
        OrganizationInvitation,
        OrganizationRole,
        OrganizationUser,
        ApiKey,
        AuditLog,
        RegistrationConsent,
      ],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    service = new LinkedIdentityService(dataSource, redis as unknown as Redis)
    await dataSource.query('ALTER TABLE "user" DROP COLUMN "registrationConsentPending"')
    await dataSource.query('ALTER TABLE "registration_consent" DROP COLUMN "accepted_by_user_id"')
    const runner = dataSource.createQueryRunner()
    try {
      await new AddAccountLinkConsentJobs1795560000000().up(runner)
      await new AddAccountLinkAttempts1795560001000().up(runner)
      await new AddAccountLinkCompletionTime1795560002000().up(runner)
    } finally {
      await runner.release()
    }
    jobs = new AccountLinkConsentJobs(
      dataSource,
      service,
      { get: () => ({}) } as unknown as TypedConfigService,
      auth0 as unknown as AccountLinkAuth0Reader,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    auth0.linkExists.mockReset().mockResolvedValue(false)
    await dataSource.query('DELETE FROM "account_link_consent_job"')
    await dataSource.getRepository(AuditLog).deleteAll()
    await dataSource.getRepository(RegistrationConsent).deleteAll()
    cache.clear()
    redis.del.mockClear()
    for (const table of ['api_key', 'organization_role_assignment', 'organization_user', 'organization_role']) {
      await dataSource.query(`DELETE FROM "${table}"`)
    }
    await dataSource.query(`DELETE FROM "organization"`)
    await dataSource.query(`DELETE FROM "user"`)
  })

  async function user(id: string, name = id) {
    await dataSource.getRepository(User).insert({
      id,
      name,
      email: 'ada@example.com',
      emailVerified: true,
      publicKeys: [],
    })
  }

  async function organization(createdBy: string, name: string): Promise<string> {
    const saved = await dataSource.getRepository(Organization).save({ name, createdBy })
    return saved.id
  }

  async function member(organizationId: string, userId: string, role: OrganizationMemberRole, isDefault: boolean) {
    await dataSource.getRepository(OrganizationUser).insert({
      organizationId,
      userId,
      role,
      isDefaultForUser: isDefault,
    })
  }

  async function role(organizationId: string, name: string): Promise<string> {
    const saved = await dataSource.getRepository(OrganizationRole).save({
      name,
      description: name,
      permissions: [],
      organizationId,
    })
    return saved.id
  }

  async function assign(organizationId: string, userId: string, roleId: string) {
    await dataSource.query(
      `INSERT INTO "organization_role_assignment" ("organizationId", "userId", "roleId") VALUES ($1, $2, $3)`,
      [organizationId, userId, roleId],
    )
  }

  async function apiKey(organizationId: string, userId: string, name: string): Promise<string> {
    const keyHash = randomUUID()
    await dataSource.getRepository(ApiKey).insert({
      organizationId,
      userId,
      name,
      keyHash,
      permissions: [],
      createdAt: new Date(),
    })
    return keyHash
  }

  function membershipsOf(userId: string): Promise<OrganizationUser[]> {
    return dataSource.getRepository(OrganizationUser).find({ where: { userId }, order: { createdAt: 'ASC' } })
  }

  async function assignmentsOf(userId: string): Promise<string[]> {
    const rows: { roleId: string }[] = await dataSource.query(
      `SELECT "roleId" FROM "organization_role_assignment" WHERE "userId" = $1 ORDER BY "roleId"`,
      [userId],
    )
    return rows.map((row) => row.roleId)
  }

  it('keeps consent with the accepting account during local adoption before Auth0 confirms', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'social organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    const records = dataSource.getRepository(RegistrationConsent)
    await records.insert({ userId: SOCIAL, tosVersion: 'terms', privacyVersion: 'privacy' })
    const original = await records.findOneByOrFail({ userId: SOCIAL })
    await service.adopt(PRIMARY, SOCIAL)
    await service.adopt(PRIMARY, SOCIAL)
    expect(await membershipsOf(PRIMARY)).toEqual([expect.objectContaining({ organizationId: org })])
    expect(await records.find()).toEqual([original])
  })

  it('preserves one source record when two confirmed links share a target', async () => {
    const second = 'github|secondary'
    await Promise.all([user(PRIMARY), user(SOCIAL), user(second)])
    const records = dataSource.getRepository(RegistrationConsent)
    await records.insert([
      { userId: SOCIAL, tosVersion: 'first', privacyVersion: 'privacy' },
      { userId: second, tosVersion: 'second', privacyVersion: 'privacy' },
    ])
    const first = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    const other = { id: randomUUID(), source_id: second, target_id: PRIMARY }
    await Promise.all([jobs.prepare(first), jobs.prepare(other)])
    await Promise.all([jobs.complete(first, 'done'), jobs.complete(other, 'done')])
    expect(await records.countBy({ userId: PRIMARY })).toBe(1)
    expect(await records.count()).toBe(2)
  })

  it('defers chain overlap and moves the original consent after each link is confirmed', async () => {
    const finalTarget = 'auth0|final'
    const first = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    const second = { id: randomUUID(), source_id: PRIMARY, target_id: finalTarget }
    await user(SOCIAL)
    const records = dataSource.getRepository(RegistrationConsent)
    await records.insert({
      userId: SOCIAL,
      acceptedByUserId: SOCIAL,
      tosVersion: 'terms',
      privacyVersion: 'privacy',
    })
    const original = await records.findOneByOrFail({ userId: SOCIAL })

    expect(await jobs.prepare(first)).toMatchObject({ operationId: first.id, ready: true })
    expect(await jobs.prepare({ ...first, id: randomUUID() })).toEqual({ operationId: first.id, ready: false })
    await expect(jobs.prepare(second)).rejects.toMatchObject({ status: 409 })
    expect(await records.find()).toEqual([original])
    expect(await dataSource.getRepository(User).findOneBy({ id: PRIMARY })).toBeNull()
    await jobs.complete(first, 'done')
    await jobs.prepare(second)
    await jobs.complete(second, 'done')
    await jobs.complete(first, 'done')
    expect(await records.find()).toEqual([{ ...original, userId: finalTarget }])
    expect(await dataSource.getRepository(User).findOneByOrFail({ id: finalTarget })).toMatchObject({
      registrationConsentPending: false,
    })
  })

  it('keeps membership and keys on the source after a rejected Auth0 link', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'source organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    await apiKey(org, SOCIAL, 'source-key')
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    await jobs.complete(operation, 'failed')

    expect(await membershipsOf(SOCIAL)).toEqual([expect.objectContaining({ organizationId: org })])
    expect(await dataSource.getRepository(ApiKey).findOneByOrFail({ name: 'source-key' })).toMatchObject({
      userId: SOCIAL,
    })
  })

  it('permits a fresh attempt for the same unconfirmed pair after checking Auth0', async () => {
    await user(SOCIAL)
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    await dataSource.query(
      `UPDATE "account_link_attempt" SET "dispatch_until" = now() - interval '2 minutes' WHERE "id" = $1`,
      [operation.id],
    )
    const retry = { ...operation, id: randomUUID() }
    expect(await jobs.prepare(retry)).toMatchObject({ operationId: operation.id, ready: true })
    expect(auth0.linkExists).toHaveBeenCalledWith(expect.objectContaining({ id: operation.id, target_id: PRIMARY }))
    await jobs.complete(operation, 'failed', { attemptId: retry.id })
    await jobs.complete(operation, 'done')
    const [job] = await dataSource.query('SELECT "state" FROM "account_link_consent_job" WHERE "id" = $1', [
      operation.id,
    ])
    expect(job.state).toBe('done')
  })

  it('leaves consent in place after rejection and ignores writes from an expired lease', async () => {
    await user(SOCIAL)
    const records = dataSource.getRepository(RegistrationConsent)
    await records.insert({ userId: SOCIAL, tosVersion: 'terms', privacyVersion: 'privacy' })
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    await dataSource.query('UPDATE "account_link_consent_job" SET "next_check_at" = now()')
    const [expired] = await jobs.claim()
    await dataSource.query('UPDATE "account_link_consent_job" SET "lease_expires_at" = now()')
    const [current] = await jobs.claim()
    expect(current.lease_token).not.toBe(expired.lease_token)
    await jobs.complete(expired, 'done', { leaseToken: expired.lease_token })
    await jobs.defer(expired)
    expect(await records.findOneBy({ userId: PRIMARY })).toBeNull()
    await jobs.complete(operation, 'failed')
    await jobs.complete(current, 'done', { leaseToken: current.lease_token })
    expect(await records.findOneBy({ userId: SOCIAL })).not.toBeNull()
    const retry = { ...operation, id: randomUUID() }
    expect(await jobs.prepare(retry)).toMatchObject({ operationId: retry.id, ready: true })
    await jobs.complete(retry, 'done')
    expect(await records.findOneBy({ userId: PRIMARY })).not.toBeNull()
  })

  it('recovers a missing callback only after Auth0 shows the exact source identity on the target', async () => {
    await user(SOCIAL)
    const records = dataSource.getRepository(RegistrationConsent)
    await records.insert({ userId: SOCIAL, tosVersion: 'terms', privacyVersion: 'privacy' })
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    const client = { id: 'read-only-client', secret: 'test-only-secret' }
    const config = {
      get: (key: string) => (key === 'oidc.accountLink.readClient' ? client : false),
      getOrThrow: (key: string) =>
        key === 'oidc.accountLink.readClient'
          ? client
          : key === 'oidc.managementApi.baseUrl'
            ? 'https://identity.example/api/v2'
            : 'https://identity.example/oauth/token',
    } as unknown as TypedConfigService
    const worker = new AccountLinkReconciliation(jobs, config, new AccountLinkAuth0Reader(config))
    const token = jest.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'read-token', expires_in: 600 } })
    const lookup = jest.spyOn(axios, 'get').mockResolvedValue({
      data: { user_id: PRIMARY, identities: [{ provider: 'github', user_id: '103' }] },
    })
    try {
      await dataSource.query('UPDATE "account_link_consent_job" SET "next_check_at" = now()')
      await worker.reconcile()
      expect(await records.findOneBy({ userId: SOCIAL })).not.toBeNull()
      lookup.mockResolvedValue({
        data: { user_id: PRIMARY, identities: [{ provider: 'google-oauth2', user_id: '103' }] },
      })
      await dataSource.query('UPDATE "account_link_consent_job" SET "next_check_at" = now()')
      await worker.reconcile()
      expect(await records.findOneBy({ userId: PRIMARY })).toMatchObject({ acceptedByUserId: null })
      expect(token).toHaveBeenCalledTimes(1)
      expect(lookup).toHaveBeenLastCalledWith(
        `https://identity.example/api/v2/users/${encodeURIComponent(PRIMARY)}`,
        expect.objectContaining({ headers: { Authorization: 'Bearer read-token' } }),
      )
    } finally {
      token.mockRestore()
      lookup.mockRestore()
    }
  })

  it('looks up the current key owner and lets the gated target accept without making another organization', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'default organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    const key = 'test-registration-consent-key'
    const keys = dataSource.getRepository(ApiKey)
    await keys.insert({
      organizationId: org,
      userId: SOCIAL,
      name: 'ci',
      keyHash: generateApiKeyHash(key),
      permissions: [],
      createdAt: new Date(),
    })
    const keyService = new ApiKeyService(keys, {} as never, {} as never, {} as never)
    const users = new UserService(dataSource.getRepository(User), new EventEmitter2(), dataSource)
    const records = dataSource.getRepository(RegistrationConsent)
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    expect(await keyService.findWithCurrentOwner(key)).toMatchObject({ apiKey: { userId: SOCIAL } })
    await jobs.complete(operation, 'done')
    expect(await keyService.findWithCurrentOwner(key)).toMatchObject({
      apiKey: { userId: PRIMARY },
      owner: { id: PRIMARY, registrationConsentPending: true },
    })
    const versions = { tosVersion: 'current-terms', privacyVersion: 'privacy' }
    expect(await users.acceptPendingRegistration(PRIMARY, versions, 'us')).toMatchObject({ accepted: true })
    expect(await records.findOneBy({ userId: PRIMARY })).toMatchObject({
      ...versions,
      acceptedByUserId: PRIMARY,
    })
    expect(await records.findOneBy({ userId: SOCIAL })).toBeNull()
    expect(await dataSource.getRepository(Organization).count()).toBe(1)
  })

  it.each([
    [true, 'done'],
    [false, 'done'],
    [true, 'failed'],
  ] as const)(
    'preserves the default after a late link result with legal=%s and outcome=%s',
    async (legalEnabled, outcome) => {
      await user(SOCIAL)
      const existingOrg = await organization(SOCIAL, 'original organization')
      await member(existingOrg, SOCIAL, OrganizationMemberRole.OWNER, true)
      const op = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
      await jobs.prepare(op)

      const events = new EventEmitter2()
      const config = { get: () => false, getOrThrow: () => undefined } as unknown as TypedConfigService
      const organizations = new OrganizationService(
        dataSource.getRepository(Organization),
        {} as never,
        events,
        config,
        {} as never,
        {} as never,
        {} as never,
      )
      events.on(UserEvents.CREATED, (event: UserCreatedEvent) => organizations.handleUserCreatedEvent(event))
      const users = new UserService(dataSource.getRepository(User), events, dataSource)
      const legal = { tosVersion: 'terms', privacyVersion: 'privacy' }
      const registration = new RegistrationService(
        users,
        {} as never,
        config,
        { recordFirstUse: async () => undefined } as never,
        { getCurrent: () => legal } as never,
      )
      const jwt = new JwtStrategy(
        { jwksUri: 'https://issuer.example/jwks', audience: 'api', issuer: 'https://issuer.example/' },
        users,
        config,
        { recordFirstUse: async () => undefined } as never,
      )
      const identity = { sub: PRIMARY, email: 'target@gmail.com', email_verified: true }
      const provision = () =>
        legalEnabled
          ? registration.register(identity, { accepted: true, ...legal })
          : jwt.validate({ get: () => undefined } as never, identity)

      await expect(provision()).rejects.toMatchObject({ status: 409, response: { code: 'account_link_pending' } })
      expect(await users.findOne(PRIMARY)).toBeNull()
      expect(await dataSource.getRepository(Organization).count()).toBe(1)

      if (outcome === 'done') {
        auth0.linkExists.mockResolvedValueOnce(true)
        const workerConfig = {
          get: (key: string) =>
            key === 'oidc.accountLink.readClient' ? { id: 'fixture', secret: 'fixture' } : undefined,
        } as unknown as TypedConfigService
        const worker = new AccountLinkReconciliation(jobs, workerConfig, auth0 as unknown as AccountLinkAuth0Reader)
        await dataSource.query('UPDATE "account_link_consent_job" SET "next_check_at" = now() WHERE "id" = $1', [op.id])
        await worker.reconcile()
        expect(auth0.linkExists).toHaveBeenCalledWith(expect.objectContaining({ id: op.id }))
      } else {
        await jobs.complete(op, outcome)
      }
      await jobs.complete(op, outcome)
      const audit = await dataSource.getRepository(AuditLog).find()
      expect(audit).toEqual([
        expect.objectContaining({
          statusCode: outcome === 'done' ? 204 : 409,
          metadata: expect.objectContaining({ scope: 'local_ownership', operationId: op.id, outcome }),
        }),
      ])
      await expect(provision()).resolves.toBeDefined()
      const defaults = (await membershipsOf(PRIMARY)).filter((membership) => membership.isDefaultForUser)
      expect(defaults).toHaveLength(1)
      if (outcome === 'done') {
        expect(defaults[0].organizationId).toBe(existingOrg)
        expect(await dataSource.getRepository(Organization).count()).toBe(1)
      } else {
        expect(defaults[0].organizationId).not.toBe(existingOrg)
        expect(await membershipsOf(SOCIAL)).toMatchObject([{ organizationId: existingOrg, isDefaultForUser: true }])
      }
    },
  )

  it('blocks a stale registration for the source after a completed link', async () => {
    const events = new EventEmitter2()
    const legal = { tosVersion: 'terms', privacyVersion: 'privacy' }
    const config = {
      get: (key: string) => (key === 'legal' ? legal : undefined),
      getOrThrow: () => undefined,
    } as unknown as TypedConfigService
    const organizations = new OrganizationService(
      dataSource.getRepository(Organization),
      {} as never,
      events,
      config,
      {} as never,
      {} as never,
      {} as never,
    )
    events.on(UserEvents.CREATED, (event: UserCreatedEvent) => organizations.handleUserCreatedEvent(event))
    const users = new UserService(dataSource.getRepository(User), events, dataSource)
    const loginEvents = { recordFirstUse: async () => undefined } as never
    const registration = new RegistrationService(users, {} as never, config, loginEvents, {
      getCurrent: () => legal,
    } as never)
    const jwt = new JwtStrategy(
      { jwksUri: 'https://issuer.example/jwks', audience: 'api', issuer: 'https://issuer.example/' },
      users,
      config,
      loginEvents,
    )
    const identity = {
      sub: SOCIAL,
      email: 'source@gmail.com',
      email_verified: true,
      iat: Math.floor(Date.now() / 1000) - 60,
    }
    await expect(jwt.validate({ get: () => undefined } as never, identity)).rejects.toMatchObject({
      status: 403,
      response: { code: 'registration_required' },
    })
    const operation = { id: randomUUID(), source_id: SOCIAL, target_id: PRIMARY }
    await jobs.prepare(operation)
    await jobs.complete(operation, 'done')

    const [job] = await dataSource.query(
      'SELECT "state", FLOOR(EXTRACT(EPOCH FROM "completed_at")) AS cutoff FROM "account_link_consent_job" WHERE "id" = $1',
      [operation.id],
    )
    expect(job.state).toBe('done')
    expect(Number(job.cutoff)).toBeGreaterThan(identity.iat)

    const body = { accepted: true, ...legal }
    for (const iat of [identity.iat, undefined, Number(job.cutoff)]) {
      await expect(registration.register({ ...identity, iat }, body)).rejects.toMatchObject({
        status: 409,
        response: { code: 'account_link_superseded' },
      })
    }

    const automaticSignup = new JwtStrategy(
      { jwksUri: 'https://issuer.example/jwks', audience: 'api', issuer: 'https://issuer.example/' },
      users,
      { get: () => undefined, getOrThrow: () => undefined } as never,
      loginEvents,
    )
    await expect(automaticSignup.validate({ get: () => undefined } as never, identity)).rejects.toMatchObject({
      status: 409,
      response: { code: 'account_link_superseded' },
    })
    expect({
      userExists: Boolean(await users.findOne(SOCIAL)),
      defaultOrganizations: (await membershipsOf(SOCIAL)).filter((m) => m.isDefaultForUser).length,
      consents: await dataSource.getRepository(RegistrationConsent).countBy({ userId: SOCIAL }),
    }).toEqual({ userExists: false, defaultOrganizations: 0, consents: 0 })

    // After unlink, Auth0 can issue a new token with the source as subject.
    await expect(registration.register({ ...identity, iat: Number(job.cutoff) + 1 }, body)).resolves.toMatchObject({
      created: true,
      user: { id: SOCIAL },
    })
    await expect(dataSource.getRepository(RegistrationConsent).countBy({ userId: SOCIAL })).resolves.toBe(1)
  })

  it('does nothing for a social identity BoxLite never saw', async () => {
    await user(PRIMARY)

    await service.adopt(PRIMARY, SOCIAL)

    expect(await dataSource.getRepository(User).count()).toBe(1)
  })

  it('gives a brand-new primary the social account and its organization as the only default', async () => {
    await user(SOCIAL, 'Ada Lovelace')
    const org = await organization(SOCIAL, 'Ada’s organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    await apiKey(org, SOCIAL, 'ci')

    await service.adopt(PRIMARY, SOCIAL)

    const primary = await dataSource.getRepository(User).findOneByOrFail({ id: PRIMARY })
    expect(primary).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: true })
    // The requirement for a first-time social login: exactly one organization,
    // and it is the one the person has been using.
    expect(await membershipsOf(PRIMARY)).toEqual([
      expect.objectContaining({ organizationId: org, role: OrganizationMemberRole.OWNER, isDefaultForUser: true }),
    ])
    expect(await dataSource.getRepository(Organization).count()).toBe(1)
    expect(await dataSource.getRepository(ApiKey).findOneByOrFail({ name: 'ci' })).toMatchObject({ userId: PRIMARY })
    expect(await dataSource.getRepository(Organization).findOneByOrFail({ id: org })).toMatchObject({
      createdBy: PRIMARY,
    })
  })

  it('keeps an existing primary’s default and adds the social organization beside it', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const own = await organization(PRIMARY, 'password org')
    const social = await organization(SOCIAL, 'social org')
    await member(own, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(social, SOCIAL, OrganizationMemberRole.OWNER, true)

    await service.adopt(PRIMARY, SOCIAL)

    const memberships = await membershipsOf(PRIMARY)
    expect(memberships).toHaveLength(2)
    expect(memberships.filter((row) => row.isDefaultForUser).map((row) => row.organizationId)).toEqual([own])
    expect(memberships.find((row) => row.organizationId === social)).toMatchObject({
      role: OrganizationMemberRole.OWNER,
      isDefaultForUser: false,
    })
    expect(await membershipsOf(SOCIAL)).toEqual([])
  })

  it('preserves an existing account whose email domain is disposable when linking identities', async () => {
    await user(SOCIAL, 'Existing User')
    await dataSource.getRepository(User).update(SOCIAL, { email: 'existing@mailinator.com' })
    const org = await organization(SOCIAL, 'Existing organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)

    await service.adopt(PRIMARY, SOCIAL)

    expect(await dataSource.getRepository(User).findOneByOrFail({ id: PRIMARY })).toMatchObject({
      email: 'existing@mailinator.com',
    })
    expect(await membershipsOf(PRIMARY)).toEqual([
      expect.objectContaining({ organizationId: org, isDefaultForUser: true }),
    ])
    expect(await dataSource.getRepository(Organization).count()).toBe(1)
  })

  it('merges a shared organization into one membership, keeping the stronger role and every assignment', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(SOCIAL, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.MEMBER, false)
    await member(shared, SOCIAL, OrganizationMemberRole.OWNER, false)
    const viewer = await role(shared, 'viewer')
    const deployer = await role(shared, 'deployer')
    await assign(shared, PRIMARY, viewer)
    await assign(shared, SOCIAL, viewer)
    await assign(shared, SOCIAL, deployer)

    await service.adopt(PRIMARY, SOCIAL)

    expect(await membershipsOf(PRIMARY)).toEqual([
      expect.objectContaining({ organizationId: shared, role: OrganizationMemberRole.OWNER }),
    ])
    expect(await assignmentsOf(PRIMARY)).toEqual([viewer, deployer].sort())
    expect(await assignmentsOf(SOCIAL)).toEqual([])
  })

  it('keeps both keys when the two accounts named one the same in a shared organization', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(PRIMARY, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(shared, SOCIAL, OrganizationMemberRole.MEMBER, true)
    await apiKey(shared, PRIMARY, 'ci')
    await apiKey(shared, SOCIAL, 'ci')

    await service.adopt(PRIMARY, SOCIAL)

    const names = (await dataSource.getRepository(ApiKey).find({ where: { userId: PRIMARY } })).map((key) => key.name)
    expect(names.sort()).toEqual(['ci', 'ci (google-oauth2)'])
  })

  it('numbers the suffix when the primary already holds the suffixed name', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(PRIMARY, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(shared, SOCIAL, OrganizationMemberRole.MEMBER, true)
    await apiKey(shared, PRIMARY, 'ci')
    await apiKey(shared, PRIMARY, 'ci (google-oauth2)')
    await apiKey(shared, SOCIAL, 'ci')

    await service.adopt(PRIMARY, SOCIAL)

    const names = (await dataSource.getRepository(ApiKey).find({ where: { userId: PRIMARY } })).map((key) => key.name)
    expect(names.sort()).toEqual(['ci', 'ci (google-oauth2 2)', 'ci (google-oauth2)'])
  })

  it('keeps two moved keys apart when one is renamed onto the name of the other', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(PRIMARY, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(shared, SOCIAL, OrganizationMemberRole.MEMBER, true)
    await apiKey(shared, PRIMARY, 'ci')
    await apiKey(shared, SOCIAL, 'ci')
    await apiKey(shared, SOCIAL, 'ci (google-oauth2)')

    await service.adopt(PRIMARY, SOCIAL)

    const names = (await dataSource.getRepository(ApiKey).find({ where: { userId: PRIMARY } })).map((key) => key.name)
    expect(names.sort()).toEqual(['ci', 'ci (google-oauth2 2)', 'ci (google-oauth2)'])
  })

  it('drops the cached owner of every moved key, and only theirs', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(PRIMARY, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(shared, SOCIAL, OrganizationMemberRole.MEMBER, true)
    const own = await apiKey(shared, PRIMARY, 'ci')
    const moved = [await apiKey(shared, SOCIAL, 'ci'), await apiKey(shared, SOCIAL, 'deploy')]
    for (const keyHash of [own, ...moved]) {
      cache.set(apiKeyValidationCacheKey(keyHash), JSON.stringify({ userId: SOCIAL }))
    }

    await service.adopt(PRIMARY, SOCIAL)

    expect([...cache.keys()]).toEqual([apiKeyValidationCacheKey(own)])
  })

  it('keeps the move when the cache cannot be reached', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'social org')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    await apiKey(org, SOCIAL, 'ci')
    redis.del.mockRejectedValueOnce(new Error('connection lost'))

    await service.adopt(PRIMARY, SOCIAL)

    expect(redis.del).toHaveBeenCalledTimes(1)
    expect(await dataSource.getRepository(ApiKey).findOneByOrFail({ name: 'ci' })).toMatchObject({ userId: PRIMARY })
  })

  it('moves nothing the second time', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'social org')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)

    await service.adopt(PRIMARY, SOCIAL)
    await service.adopt(PRIMARY, SOCIAL)

    expect(await membershipsOf(PRIMARY)).toHaveLength(1)
  })
})
