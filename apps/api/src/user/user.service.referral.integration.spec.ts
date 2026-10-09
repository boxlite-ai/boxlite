/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { CommerceUnavailableError } from '../commerce/commerce.errors'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { ReferralRegistrationException } from '../exceptions/referral-registration.exception'
import { User } from './user.entity'
import { UserService } from './user.service'

jest.mock('../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `user_referral_event_${process.pid}_${randomUUID().replaceAll('-', '')}`
const INVITER_ID = '0b5f4d6e-8c1a-4f7b-9e2d-3a6c8b1f0e47'

// The mocked specs cannot show what Postgres does: that createdAt exists when the
// event is sent, and that a refused event leaves no account behind.
describeIfDatabase('UserService referral event (integration, real Postgres)', () => {
  let dataSource: DataSource
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [User],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  function createReferredUser(publishReferralNewer: jest.Mock): { id: string; created: Promise<User> } {
    const commerce = {
      isConfigured: () => true,
      acceptsInviteeEmail: () => true,
      resolveReferralCode: async () => INVITER_ID,
      publishReferralNewer,
    }
    // The default organization is not under test; its listener writes through the same transaction.
    const eventEmitter = { emitAsync: async () => [{ id: 'org-1' }] }
    const service = new UserService(
      dataSource.getRepository(User),
      eventEmitter as never,
      dataSource,
      commerce as never,
    )
    // RSA-4096 generation would dominate the test's time budget.
    jest
      .spyOn(service as never, 'generatePrivateKey')
      .mockResolvedValue({ privateKey: 'private-key', publicKey: 'public-key' } as never)
    const id = `google-oauth2|${randomUUID()}`
    const dto = { id, name: 'Invitee', email: 'invitee@example.com', emailVerified: false }
    return { id, created: service.create(dto as never, 'user', 'ABCD2345EF') }
  }

  it('sends the event with the createdAt Postgres stored', async () => {
    const publish = jest.fn().mockResolvedValue(undefined)

    const { id, created } = createReferredUser(publish)
    await created

    const stored = await dataSource.getRepository(User).findOneByOrFail({ id })
    const [[inviterOrganizationId, invitee]] = publish.mock.calls
    expect(inviterOrganizationId).toBe(INVITER_ID)
    expect(invitee.createdAt).toBeInstanceOf(Date)
    expect(invitee.createdAt.getTime()).toBe(stored.createdAt.getTime())
    expect(stored.referredByOrganizationId).toBe(INVITER_ID)
  })

  it('leaves no account behind when Commerce refuses the event', async () => {
    const publish = jest.fn().mockRejectedValue(new CommerceUnavailableError('Commerce is unavailable (HTTP 503)'))

    const { id, created } = createReferredUser(publish)

    await expect(created).rejects.toBeInstanceOf(ReferralRegistrationException)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await dataSource.getRepository(User).countBy({ id })).toBe(0)
  })
})
