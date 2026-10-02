/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, Logger } from '@nestjs/common'
import { User } from './user.entity'
import { UserService } from './user.service'
import { Context } from '../common/context/context'
import { CommerceUnavailableError } from '../commerce/commerce.errors'
import { ReferralRegistrationException } from '../exceptions/referral-registration.exception'

const INVITER_ID = '0b5f4d6e-8c1a-4f7b-9e2d-3a6c8b1f0e47'
const NEW_USER = { id: 'user-1', name: 'User One', email: 'new@boxlite.dev', emailVerified: true }

function makeService(commerceOverrides: Record<string, jest.Mock> = {}) {
  const commerce = {
    isConfigured: jest.fn().mockReturnValue(true),
    resolveReferralCode: jest.fn().mockResolvedValue(INVITER_ID),
    ...commerceOverrides,
  }
  let inserted: User
  const entityManager = {
    insert: jest.fn(async (_entity, user: User) => {
      inserted = user
    }),
    findOneByOrFail: jest.fn(async () => inserted),
  }
  const transaction = jest.fn(async (callback) => callback(entityManager))
  const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([{ id: 'org-1' }]) }
  const service = new UserService({} as never, eventEmitter as never, { transaction } as never, commerce as never)
  return { service, commerce, entityManager, transaction }
}

describe('UserService referral attribution', () => {
  let logged: [string, Record<string, string>][]

  beforeEach(() => {
    logged = []
    const record = (message: string, attributes: Record<string, string>) => void logged.push([message, attributes])
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record as never)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(record as never)
  })

  afterEach(() => jest.restoreAllMocks())

  it('saves the organization the referral code resolves to', async () => {
    const { service, commerce, entityManager } = makeService()

    await service.create(NEW_USER as never, Context.user(), ' abcd2345ef ')

    expect(commerce.resolveReferralCode).toHaveBeenCalledWith(' abcd2345ef ')
    expect(entityManager.insert).toHaveBeenCalledWith(
      User,
      expect.objectContaining({ id: 'user-1', referredByOrganizationId: INVITER_ID }),
    )
    expect(logged.at(-1)?.[0]).toBe('user.registration success')
  })

  it.each([undefined, '', '   '])('creates an unreferred user for a %p code without asking Commerce', async (code) => {
    const { service, commerce, entityManager } = makeService()

    await service.create(NEW_USER as never, Context.user(), code)

    expect(commerce.isConfigured).not.toHaveBeenCalled()
    expect(commerce.resolveReferralCode).not.toHaveBeenCalled()
    expect(entityManager.insert).toHaveBeenCalledWith(User, expect.objectContaining({ referredByOrganizationId: null }))
  })

  // Without Commerce the API behaves as before referrals existed, whatever the client sends.
  it('ignores even a malformed code when Commerce is not configured', async () => {
    const { service, commerce, entityManager } = makeService({ isConfigured: jest.fn().mockReturnValue(false) })

    await service.create(NEW_USER as never, Context.user(), 'garbage')

    expect(commerce.resolveReferralCode).not.toHaveBeenCalled()
    expect(entityManager.insert).toHaveBeenCalledWith(User, expect.objectContaining({ referredByOrganizationId: null }))
  })

  it.each([
    [
      'an unknown or malformed code',
      () => jest.fn().mockResolvedValue(null),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'invalid_referral_code',
    ],
    [
      'Commerce being unavailable',
      () => jest.fn().mockRejectedValue(new CommerceUnavailableError('Commerce referral code lookup is unavailable')),
      HttpStatus.SERVICE_UNAVAILABLE,
      'referral_unavailable',
    ],
  ])('refuses the registration for %s before creating anything', async (_label, resolver, status, code) => {
    const { service, transaction } = makeService({ resolveReferralCode: resolver() })

    const error = await service.create(NEW_USER as never, Context.user(), 'ABCD2345EF').catch((caught) => caught)

    expect(error).toBeInstanceOf(ReferralRegistrationException)
    expect(error.getStatus()).toBe(status)
    expect(error.getResponse()).toMatchObject({ code })
    expect(transaction).not.toHaveBeenCalled()
    expect(logged).toEqual([
      ['user.registration requested', expect.objectContaining({ 'correlation.id': 'user-1', 'actor.kind': 'user' })],
      [
        'user.registration exception',
        expect.objectContaining({ 'correlation.id': 'user-1', 'actor.kind': 'user', 'exception.type': code }),
      ],
    ])
  })

  it('propagates an unexpected lookup failure unchanged', async () => {
    const failure = new TypeError('boom')
    const { service, transaction } = makeService({ resolveReferralCode: jest.fn().mockRejectedValue(failure) })

    await expect(service.create(NEW_USER as never, Context.user(), 'ABCD2345EF')).rejects.toBe(failure)

    expect(transaction).not.toHaveBeenCalled()
    expect(logged.at(-1)).toEqual([
      'user.registration exception',
      expect.objectContaining({ 'exception.type': 'internal' }),
    ])
  })
})
