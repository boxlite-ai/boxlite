/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus } from '@nestjs/common'
import { UserService } from './user.service'
import { recordBusinessEvent } from '../common/utils/business-event.util'
import { CommerceUnavailableError } from '../commerce/commerce.errors'
import { ReferralRegistrationException } from '../exceptions/referral-registration.exception'

jest.mock('../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

const INVITER_ID = '0b5f4d6e-8c1a-4f7b-9e2d-3a6c8b1f0e47'
const NEW_USER = { id: 'user-1', name: 'User One', email: 'new@boxlite.dev', emailVerified: true }

function makeService(commerceOverrides: Record<string, jest.Mock> = {}) {
  const commerce = {
    isConfigured: jest.fn().mockReturnValue(true),
    resolveReferralCode: jest.fn().mockResolvedValue(INVITER_ID),
    ...commerceOverrides,
  }
  const entityManager = { save: jest.fn(async (entity) => entity) }
  const transaction = jest.fn(async (callback) => callback(entityManager))
  const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([{ id: 'org-1' }]) }
  const service = new UserService({} as never, eventEmitter as never, { transaction } as never, commerce as never)
  const generatePrivateKey = jest.spyOn(service as never, 'generatePrivateKey').mockResolvedValue({
    privateKey: 'private-key',
    publicKey: 'public-key',
  } as never)
  return { service, commerce, entityManager, transaction, generatePrivateKey }
}

describe('UserService referral attribution', () => {
  beforeEach(() => jest.mocked(recordBusinessEvent).mockClear())

  it('saves the organization the referral code resolves to', async () => {
    const { service, commerce, entityManager } = makeService()

    await service.create(NEW_USER as never, 'user', ' abcd2345ef ')

    expect(commerce.resolveReferralCode).toHaveBeenCalledWith(' abcd2345ef ')
    expect(entityManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', referredByOrganizationId: INVITER_ID }),
    )
    expect(recordBusinessEvent).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success' }))
  })

  it.each([undefined, '', '   '])('creates an unreferred user for a %p code without asking Commerce', async (code) => {
    const { service, commerce, entityManager } = makeService()

    await service.create(NEW_USER as never, 'user', code)

    expect(commerce.isConfigured).not.toHaveBeenCalled()
    expect(commerce.resolveReferralCode).not.toHaveBeenCalled()
    expect(entityManager.save).toHaveBeenCalledWith(expect.objectContaining({ referredByOrganizationId: null }))
  })

  // Without Commerce the API behaves as before referrals existed, whatever the client sends.
  it('ignores even a malformed code when Commerce is not configured', async () => {
    const { service, commerce, entityManager } = makeService({ isConfigured: jest.fn().mockReturnValue(false) })

    await service.create(NEW_USER as never, 'user', 'garbage')

    expect(commerce.resolveReferralCode).not.toHaveBeenCalled()
    expect(entityManager.save).toHaveBeenCalledWith(expect.objectContaining({ referredByOrganizationId: null }))
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
    const { service, transaction, generatePrivateKey } = makeService({ resolveReferralCode: resolver() })

    const error = await service.create(NEW_USER as never, 'user', 'ABCD2345EF').catch((caught) => caught)

    expect(error).toBeInstanceOf(ReferralRegistrationException)
    expect(error.getStatus()).toBe(status)
    expect(error.getResponse()).toMatchObject({ code })
    // A refused sign-up leaves the identity new, so it can be retried; it must
    // not cost a key generation or leave rows behind.
    expect(generatePrivateKey).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(jest.mocked(recordBusinessEvent).mock.calls).toEqual([
      [{ name: 'user.registration', outcome: 'requested', correlationId: 'user-1', actorKind: 'user' }],
      [
        {
          name: 'user.registration',
          outcome: 'exception',
          correlationId: 'user-1',
          actorKind: 'user',
          exceptionType: code,
        },
      ],
    ])
  })

  it('propagates an unexpected lookup failure unchanged', async () => {
    const failure = new TypeError('boom')
    const { service, transaction } = makeService({ resolveReferralCode: jest.fn().mockRejectedValue(failure) })

    await expect(service.create(NEW_USER as never, 'user', 'ABCD2345EF')).rejects.toBe(failure)

    expect(transaction).not.toHaveBeenCalled()
    expect(recordBusinessEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'exception', exceptionType: 'internal' }),
    )
  })
})
