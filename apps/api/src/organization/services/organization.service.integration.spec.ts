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
import { AddOrganizationExecTimeout1790640000000 } from '../../migrations/pre-deploy/1790640000000-add-organization-exec-timeout-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `org_referral_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('OrganizationService.getReferralCode (integration, real Postgres)', () => {
  let dataSource: DataSource
  let organizations: Repository<Organization>
  let service: OrganizationService
  let organizationId: string

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    organizations = dataSource.getRepository(Organization)
    service = new OrganizationService(
      organizations,
      {} as any,
      {} as any,
      { getOrThrow: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
    Object.assign(service, { redis: { del: jest.fn().mockResolvedValue(0) } })
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
    const organization = await organizations.save({ name: 'Referral test', createdBy: 'referral-test' })
    organizationId = organization.id
  })

  afterEach(() => jest.restoreAllMocks())

  it('exec timeout migration inherits, accepts overrides and rolls back', async () => {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
      await runner.startTransaction()
      await runner.query('CREATE TEMP TABLE "organization" ("id" integer PRIMARY KEY) ON COMMIT DROP')
      await runner.query('INSERT INTO "organization" ("id") VALUES (1)')
      const migration = new AddOrganizationExecTimeout1790640000000()
      await migration.up(runner)
      await runner.query('INSERT INTO "organization" ("id") VALUES (2)')
      expect(await runner.query('SELECT "defaultExecTimeoutSeconds" FROM "organization"')).toEqual([
        { defaultExecTimeoutSeconds: null },
        { defaultExecTimeoutSeconds: null },
      ])
      for (const seconds of [1800, 0, 2147483647, null]) {
        await runner.query('UPDATE "organization" SET "defaultExecTimeoutSeconds" = $1 WHERE "id" = 1', [seconds])
        const [stored] = await runner.query('SELECT "defaultExecTimeoutSeconds" FROM "organization" WHERE "id" = 1')
        expect(stored.defaultExecTimeoutSeconds).toBe(seconds)
      }
      await runner.query('SAVEPOINT invalid_timeout')
      await expect(runner.query('UPDATE "organization" SET "defaultExecTimeoutSeconds" = -1')).rejects.toMatchObject({
        code: '23514',
      })
      await runner.query('ROLLBACK TO SAVEPOINT invalid_timeout')
      await migration.down(runner)
      expect(await runner.query('SELECT * FROM "organization" ORDER BY "id"')).toEqual([{ id: 1 }, { id: 2 }])
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  })

  it('persists and clears the exec timeout without changing another organization', async () => {
    const other = await organizations.save({ name: 'Other organization', createdBy: 'timeout-test' })
    for (const seconds of [1800, 0, null]) {
      await service.updateDefaultExecTimeout(organizationId, seconds)
      expect((await organizations.findOneByOrFail({ id: organizationId })).defaultExecTimeoutSeconds).toBe(seconds)
      expect((await organizations.findOneByOrFail({ id: other.id })).defaultExecTimeoutSeconds).toBeNull()
    }
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
    expect(await organizations.findOneByOrFail({ id: organizationId })).toMatchObject({ referralCode: first.referralCode })
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
    expect(await organizations.findOneByOrFail({ id: organizationId })).toMatchObject({ referralCode: result.referralCode })
    expect(await organizations.findOneByOrFail({ id: existing.id })).toMatchObject({ referralCode: existing.referralCode })
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
