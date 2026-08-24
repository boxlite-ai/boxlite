/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { SIGNUP_CREDIT_LOCK_TIMEOUT_MS } from '../config/configuration'
import { AddSignupCreditOutbox1786400000000 } from '../migrations/pre-deploy/1786400000000-add-signup-credit-outbox-migration'
import { UserCreationSource } from '../user/enums/user-creation-source.enum'
import { UserCreatedEvent } from '../user/events/user-created.event'
import { User } from '../user/user.entity'
import { UserService } from '../user/user.service'
import {
  SignupCreditEligibilityKind,
  SignupCreditOutbox,
  SignupCreditOutboxStatus,
} from './entities/signup-credit-outbox.entity'
import { SignupCreditOutboxService, signupCreditEventKey } from './services/signup-credit-outbox.service'
import { SignupCreditPublisherService } from './services/signup-credit-publisher.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `signup_credit_${process.pid}_${randomUUID().replaceAll('-', '')}`
const qualified = (table: string) => `"${schemaName}"."${table}"`
const amountCents = 10_000

describeIfDatabase('signup credit (integration, real Postgres)', () => {
  let dataSource: DataSource
  let outboxes: Repository<SignupCreditOutbox>
  let outboxService: SignupCreditOutboxService
  let ownsSchema = false

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'signupCredit.amountCents') return amountCents
      if (key === 'signupCredit.batchSize') return 3
      throw new Error(`unexpected config key ${key}`)
    }),
  }

  const organizationIds = Array.from(
    { length: 6 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  )

  async function insertOrganization(organizationId: string): Promise<void> {
    await dataSource.query(`INSERT INTO ${qualified('organization')} ("id") VALUES ($1)`, [organizationId])
  }

  async function insertOutbox(
    organizationId: string,
    status: SignupCreditOutboxStatus,
    overrides: Partial<SignupCreditOutbox> = {},
  ): Promise<void> {
    await insertOrganization(organizationId)
    const terminalAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await outboxes.insert({
      eventKey: signupCreditEventKey(organizationId),
      organizationId,
      payload: { schemaVersion: 1, amountCents },
      status,
      attempts: 0,
      availableAt: new Date(0),
      eligibleAt: status === SignupCreditOutboxStatus.AWAITING_VERIFICATION ? null : new Date(),
      eligibilityKind:
        status === SignupCreditOutboxStatus.AWAITING_VERIFICATION
          ? null
          : SignupCreditEligibilityKind.REGISTERED_VERIFIED,
      deliveredAt: status === SignupCreditOutboxStatus.DELIVERED ? terminalAt : null,
      cancelledAt: status === SignupCreditOutboxStatus.CANCELLED ? terminalAt : null,
      lastError: null,
      ...overrides,
    })
  }

  function userServiceWith(listener: (event: UserCreatedEvent) => Promise<void>): UserService {
    const service = new UserService(
      dataSource.getRepository(User),
      { emitAsync: jest.fn(async (_eventName: string, event: UserCreatedEvent) => listener(event)) } as never,
      dataSource,
    )
    jest.spyOn(service as any, 'generatePrivateKey').mockResolvedValue({
      publicKey: 'ssh-rsa test boxlite',
      privateKey: 'test-private-key',
    })
    return service
  }

  async function createDefaultOrganizationAndOutbox(event: UserCreatedEvent): Promise<void> {
    const organizationId = organizationIds[0]
    await event.entityManager.query(`INSERT INTO ${qualified('organization')} ("id") VALUES ($1)`, [organizationId])
    await outboxService.enqueueForDefaultOrganization(
      event.entityManager,
      organizationId,
      event.creationSource,
      event.user.emailVerified,
    )
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
      entities: [User, SignupCreditOutbox],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      // `schema` qualifies ORM-generated queries but does not change how raw
      // SQL resolves tables. The publisher uses raw SQL from concurrent pool
      // connections, so every connection must start in this test's schema.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    await dataSource.query(`DROP TABLE ${qualified('signup_credit_outbox')}`)
    await dataSource.query(`CREATE TABLE ${qualified('organization')} ("id" uuid PRIMARY KEY)`)

    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await new AddSignupCreditOutbox1786400000000().up(queryRunner)
    } finally {
      await queryRunner.release()
    }

    outboxes = dataSource.getRepository(SignupCreditOutbox)
    outboxService = new SignupCreditOutboxService(outboxes, config as never)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      if (ownsSchema) await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE ${qualified('signup_credit_outbox')}, ${qualified('organization')}, ${qualified('user')} CASCADE`,
    )
  })

  it('commits the user, default organization, and immutable credit snapshot together', async () => {
    const service = userServiceWith(createDefaultOrganizationAndOutbox)

    await service.create(
      { id: 'oidc-user-1', name: 'OIDC User', email: 'user@example.com', emailVerified: true },
      UserCreationSource.OIDC,
    )

    expect(await dataSource.getRepository(User).count()).toBe(1)
    expect((await dataSource.query(`SELECT count(*)::int AS count FROM ${qualified('organization')}`))[0].count).toBe(1)
    expect(await outboxes.find()).toEqual([
      expect.objectContaining({
        organizationId: organizationIds[0],
        status: SignupCreditOutboxStatus.PENDING,
        payload: { schemaVersion: 1, amountCents },
      }),
    ])
  })

  it('rolls the user and organization back when the outbox insert fails', async () => {
    await dataSource.query(`CREATE FUNCTION "${schemaName}".reject_signup_credit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic signup credit failure'; END;
    $$ LANGUAGE plpgsql`)
    await dataSource.query(`CREATE TRIGGER reject_signup_credit BEFORE INSERT ON ${qualified('signup_credit_outbox')}
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".reject_signup_credit()`)
    const service = userServiceWith(createDefaultOrganizationAndOutbox)

    try {
      await expect(
        service.create(
          { id: 'oidc-user-rollback', name: 'OIDC User', email: 'rollback@example.com', emailVerified: true },
          UserCreationSource.OIDC,
        ),
      ).rejects.toThrow('synthetic signup credit failure')
    } finally {
      await dataSource.query(`DROP TRIGGER IF EXISTS reject_signup_credit ON ${qualified('signup_credit_outbox')}`)
      await dataSource.query(`DROP FUNCTION IF EXISTS "${schemaName}".reject_signup_credit()`)
    }

    expect(await dataSource.getRepository(User).count()).toBe(0)
    expect((await dataSource.query(`SELECT count(*)::int AS count FROM ${qualified('organization')}`))[0].count).toBe(0)
    expect(await outboxes.count()).toBe(0)
  })

  it('claims concurrent batches without overlap and makes a crashed claim eligible again', async () => {
    for (const organizationId of organizationIds.slice(0, 4)) {
      await insertOutbox(organizationId, SignupCreditOutboxStatus.PENDING)
    }
    const publisher = () => new SignupCreditPublisherService(outboxes, outboxService, {} as never, config as never)

    const [first, second] = await Promise.all([publisher().claimBatch(), publisher().claimBatch()])
    const claimedKeys = [...first, ...second].map((row) => row.eventKey)
    expect(claimedKeys).toHaveLength(4)
    expect(new Set(claimedKeys).size).toBe(4)
    await expect(publisher().claimBatch()).resolves.toHaveLength(0)

    await dataSource.query(
      `UPDATE ${qualified('signup_credit_outbox')} SET "availableAt" = now() - interval '1 second'`,
    )
    await expect(publisher().claimBatch()).resolves.toHaveLength(3)
  })

  it('enforces one row per organization and cascades organization deletion', async () => {
    await insertOutbox(organizationIds[0], SignupCreditOutboxStatus.AWAITING_VERIFICATION)
    await expect(
      outboxes.insert({
        eventKey: 'signup-credit:v2:duplicate',
        organizationId: organizationIds[0],
        payload: { schemaVersion: 1, amountCents },
        status: SignupCreditOutboxStatus.PENDING,
        attempts: 0,
        availableAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: '23505' })

    await dataSource.query(`DELETE FROM ${qualified('organization')} WHERE "id" = $1`, [organizationIds[0]])
    expect(await outboxes.count()).toBe(0)
  })

  it('lets organization deletion win before delivery acquires the parent lock', async () => {
    await insertOutbox(organizationIds[0], SignupCreditOutboxStatus.PENDING)
    const credit = await outboxes.findOneByOrFail({ organizationId: organizationIds[0] })
    const publisher = new SignupCreditPublisherService(
      outboxes,
      outboxService,
      {} as never,
      {
        get: jest.fn(
          (key: string) =>
            ({
              'signupCredit.url': 'https://commerce.test',
              'signupCredit.token': 'secret',
              'signupCredit.timeoutMs': 3_000,
            })[key],
        ),
      } as never,
    )
    const put = jest.spyOn(axios, 'put').mockResolvedValue({ status: 204 })
    const deletion = dataSource.createQueryRunner()
    await deletion.connect()
    await deletion.startTransaction()

    try {
      await deletion.query(`SELECT "id" FROM ${qualified('organization')} WHERE "id" = $1 FOR UPDATE`, [
        organizationIds[0],
      ])
      const delivery = (publisher as unknown as { deliverOne(row: SignupCreditOutbox): Promise<void> }).deliverOne(
        credit,
      )
      await new Promise((resolve) => setImmediate(resolve))
      await deletion.query(`DELETE FROM ${qualified('organization')} WHERE "id" = $1`, [organizationIds[0]])
      await deletion.commitTransaction()
      await delivery

      expect(put).not.toHaveBeenCalled()
      expect(await outboxes.count()).toBe(0)
    } finally {
      if (deletion.isTransactionActive) await deletion.rollbackTransaction()
      await deletion.release()
      put.mockRestore()
      await publisher.onApplicationShutdown()
    }
  })

  it('bounds a contended organization lock and leaves the claimed row pending', async () => {
    await insertOutbox(organizationIds[0], SignupCreditOutboxStatus.PENDING)
    const credit = await outboxes.findOneByOrFail({ organizationId: organizationIds[0] })
    const publisher = new SignupCreditPublisherService(
      outboxes,
      outboxService,
      {} as never,
      {
        get: jest.fn(
          (key: string) =>
            ({
              'signupCredit.url': 'https://commerce.test',
              'signupCredit.token': 'secret',
              'signupCredit.timeoutMs': 3_000,
            })[key],
        ),
      } as never,
    )
    const put = jest.spyOn(axios, 'put').mockResolvedValue({ status: 204 })
    const lockHolder = dataSource.createQueryRunner()
    await lockHolder.connect()
    await lockHolder.startTransaction()
    let delivery!: Promise<void>
    let watchdog!: ReturnType<typeof setTimeout>

    try {
      await lockHolder.query(`SELECT "id" FROM ${qualified('organization')} WHERE "id" = $1 FOR UPDATE`, [
        organizationIds[0],
      ])
      delivery = (publisher as unknown as { deliverOne(row: SignupCreditOutbox): Promise<void> }).deliverOne(credit)
      const outcome = await Promise.race([
        delivery.then(() => 'completed' as const),
        new Promise<'timed-out'>((resolve) => {
          watchdog = setTimeout(() => resolve('timed-out'), SIGNUP_CREDIT_LOCK_TIMEOUT_MS + 1_500)
        }),
      ])
      clearTimeout(watchdog)

      expect(outcome).toBe('completed')
      expect(put).not.toHaveBeenCalled()
      expect(await outboxes.findOneByOrFail({ eventKey: credit.eventKey })).toMatchObject({
        status: SignupCreditOutboxStatus.PENDING,
        attempts: 0,
      })
    } finally {
      clearTimeout(watchdog)
      if (lockHolder.isTransactionActive) await lockHolder.rollbackTransaction()
      await delivery
      await lockHolder.release()
      put.mockRestore()
      await publisher.onApplicationShutdown()
    }
  })

  it('lets delivery win while the organization exists and makes deletion wait', async () => {
    await insertOutbox(organizationIds[0], SignupCreditOutboxStatus.PENDING)
    const credit = await outboxes.findOneByOrFail({ organizationId: organizationIds[0] })
    const publisher = new SignupCreditPublisherService(
      outboxes,
      outboxService,
      {} as never,
      {
        get: jest.fn(
          (key: string) =>
            ({
              'signupCredit.url': 'https://commerce.test',
              'signupCredit.token': 'secret',
              'signupCredit.timeoutMs': 3_000,
            })[key],
        ),
      } as never,
    )
    let releaseHttp!: () => void
    let reachedHttp!: () => void
    const atHttp = new Promise<void>((resolve) => {
      reachedHttp = resolve
    })
    const httpRelease = new Promise<void>((resolve) => {
      releaseHttp = resolve
    })
    const put = jest.spyOn(axios, 'put').mockImplementation(async () => {
      reachedHttp()
      await httpRelease
      return { status: 204 }
    })

    try {
      const delivery = (publisher as unknown as { deliverOne(row: SignupCreditOutbox): Promise<void> }).deliverOne(
        credit,
      )
      await atHttp
      let deletionFinished = false
      const deletion = dataSource
        .query(`DELETE FROM ${qualified('organization')} WHERE "id" = $1`, [organizationIds[0]])
        .finally(() => {
          deletionFinished = true
        })
      await new Promise((resolve) => setImmediate(resolve))
      expect(deletionFinished).toBe(false)

      releaseHttp()
      await delivery
      await deletion

      expect(put).toHaveBeenCalledTimes(1)
      expect(await outboxes.count()).toBe(0)
    } finally {
      releaseHttp()
      put.mockRestore()
      await publisher.onApplicationShutdown()
    }
  })

  it('prunes old delivered and cancelled rows while retaining blocked rows', async () => {
    await insertOutbox(organizationIds[0], SignupCreditOutboxStatus.DELIVERED)
    await insertOutbox(organizationIds[1], SignupCreditOutboxStatus.CANCELLED)
    await insertOutbox(organizationIds[2], SignupCreditOutboxStatus.BLOCKED, {
      lastError: 'operator intervention required',
    })

    await expect(outboxService.pruneTerminal(30)).resolves.toBe(2)
    expect(await outboxes.find()).toEqual([
      expect.objectContaining({
        organizationId: organizationIds[2],
        status: SignupCreditOutboxStatus.BLOCKED,
      }),
    ])
  })
})
