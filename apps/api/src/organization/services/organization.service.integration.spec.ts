/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Organization } from '../entities/organization.entity'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationService } from './organization.service'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { User } from '../../user/user.entity'
import { UserService } from '../../user/user.service'
import { UserEvents } from '../../user/constants/user-events.constant'
import { RegionType } from '../../region/enums/region-type.enum'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `org_referral_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('OrganizationService referrals (integration, real Postgres)', () => {
  let dataSource: DataSource
  let organizations: Repository<Organization>
  let service: OrganizationService
  let organizationId: string
  let users: UserService
  const defaultRegionId = randomUUID()

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser, User],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    organizations = dataSource.getRepository(Organization)
    const events = new EventEmitter2()
    service = new OrganizationService(
      organizations,
      {} as any,
      events,
      { getOrThrow: () => false, get: () => false } as any,
      {} as any,
      {} as any,
      { findOne: async () => ({ regionType: RegionType.SHARED }) } as any,
      {} as any,
    )
    events.on(UserEvents.CREATED, (event) => service.handleUserCreatedEvent(event))
    users = new UserService(dataSource.getRepository(User), events, dataSource)
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
    await organizations.query(`DELETE FROM "${schemaName}"."organization"`)
    await dataSource.getRepository(User).clear()
    jest.spyOn(users as any, 'generatePrivateKey').mockResolvedValue({ privateKey: 'test', publicKey: 'test' })
    const organization = await organizations.save({ name: 'Referral test', createdBy: 'referral-test' })
    organizationId = organization.id
  })

  afterEach(() => jest.restoreAllMocks())

  it.each([undefined, 'ABCD2345EF'])('persists default organization attribution for code %p', async (referredCode) => {
    await organizations.update(organizationId, { referralCode: 'ABCD2345EF' })
    const user = await users.create(
      { id: 'new-user', name: 'New user', emailVerified: true, defaultOrganizationDefaultRegionId: defaultRegionId },
      referredCode,
    )
    const organization = await organizations.findOneByOrFail({ createdBy: user.id })
    expect(organization).toMatchObject({
      defaultRegionId,
      referredCode: referredCode ?? null,
      inviterOrganizationId: referredCode ? organizationId : null,
      referralCode: null,
    })
    expect(await dataSource.getRepository(OrganizationUser).findBy({ userId: user.id })).toMatchObject([
      { organizationId: organization.id, isDefaultForUser: true, role: 'owner' },
    ])
    expect(await users.findOne(user.id)).not.toBeNull()
  })

  it.each([null, new Date(Date.now() + 86400000), undefined])(
    'rolls back registration for an unavailable inviter (%p)',
    async (suspendedUntil) => {
      if (suspendedUntil !== undefined) {
        await organizations.update(organizationId, { referralCode: 'ABCD2345EF', suspended: true, suspendedUntil })
      }
      await expect(
        users.create({ id: 'new-user', name: 'New user', emailVerified: true }, 'ABCD2345EF'),
      ).rejects.toMatchObject({
        response: { statusCode: 422, code: 'invitation_unavailable' },
      })
      expect(await users.findOne('new-user')).toBeNull()
      expect(await organizations.countBy({ createdBy: 'new-user' })).toBe(0)
      expect(await dataSource.getRepository(OrganizationUser).countBy({ userId: 'new-user' })).toBe(0)
    },
  )

  it('accepts an inviter whose suspension has expired', async () => {
    await organizations.update(organizationId, {
      referralCode: 'ABCD2345EF',
      suspended: true,
      suspendedUntil: new Date(0),
    })
    await users.create({ id: 'new-user', name: 'New user', emailVerified: true }, 'ABCD2345EF')
    expect(await organizations.findOneByOrFail({ createdBy: 'new-user' })).toMatchObject({
      inviterOrganizationId: organizationId,
    })
  })

  it('returns and persists one code for two independent concurrent transactions', async () => {
    const transaction = organizations.manager.transaction.bind(organizations.manager)
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => (release = resolve))
    jest.spyOn(organizations.manager, 'transaction').mockImplementation((...args: unknown[]) =>
      transaction(async (manager) => {
        if (++started === 2) release()
        await bothStarted
        return (args[0] as (manager: EntityManager) => Promise<unknown>)(manager)
      }),
    )

    const [first, second] = await Promise.all([
      service.getReferralCode(organizationId),
      service.getReferralCode(organizationId),
    ])

    expect(started).toBe(2)
    expect(first).toEqual(second)
    expect(first.referralCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
    expect(await organizations.findOneByOrFail({ id: organizationId })).toMatchObject({
      referralCode: first.referralCode,
    })
  })

  it('retries a database uniqueness collision and persists the next code', async () => {
    const existing = await organizations.save({
      name: 'Existing inviter',
      createdBy: 'referral-test',
      referralCode: 'ABCD2345EF',
    })
    const generateCode = jest
      .spyOn(service as any, 'generateReferralCode')
      .mockReturnValueOnce(existing.referralCode)
      .mockReturnValueOnce('7KMNP4XZQ2')

    const result = await service.getReferralCode(organizationId)

    expect(result).toEqual({ organizationId, referralCode: '7KMNP4XZQ2' })
    expect(generateCode).toHaveBeenCalledTimes(2)
    expect(await organizations.findOneByOrFail({ id: organizationId })).toMatchObject({
      referralCode: result.referralCode,
    })
    expect(await organizations.findOneByOrFail({ id: existing.id })).toMatchObject({
      referralCode: existing.referralCode,
    })
  })

  it('maps a PostgreSQL row-lock timeout to 503 without persisting a code', async () => {
    const blocker = dataSource.createQueryRunner()
    await blocker.connect()
    await blocker.startTransaction()
    try {
      await blocker.manager.findOneOrFail(Organization, {
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      })

      await expect(service.getReferralCode(organizationId)).rejects.toMatchObject({
        response: { statusCode: 503, code: 'referral_code_unavailable' },
      })
      expect(await organizations.findOneByOrFail({ id: organizationId })).toMatchObject({ referralCode: null })
    } finally {
      await blocker.rollbackTransaction()
      await blocker.release()
    }
  }, 15000)
})
