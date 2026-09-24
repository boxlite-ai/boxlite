/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, NotFoundException } from '@nestjs/common'
import { Organization } from '../entities/organization.entity'
import { OrganizationService } from './organization.service'

const organization = (overrides: Partial<Organization> = {}): Organization =>
  Object.assign(new Organization(), {
    id: 'org-1',
    suspended: false,
    suspensionReason: null,
    suspendedUntil: null,
    suspendedAt: null,
    ...overrides,
  })

const makeService = (found: Organization | null) => {
  const entityManager = {
    query: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(found),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  }
  const organizationRepository = {
    findOne: jest.fn().mockResolvedValue(found),
    save: jest.fn().mockImplementation((org: Organization) => Promise.resolve(org)),
    manager: {
      transaction: jest.fn((callback) => callback(entityManager)),
    },
  }
  const configService = { getOrThrow: jest.fn().mockReturnValue(false), get: jest.fn() }

  const service = new OrganizationService(
    organizationRepository as any,
    {} as any,
    {} as any,
    configService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  )

  return { service, organizationRepository, entityManager }
}

describe('OrganizationService.getReferralCode', () => {
  it('returns an existing code without writing', async () => {
    const { service, entityManager } = makeService(organization({ referralCode: 'ABCD2345EF', suspended: false }))

    await expect(service.getReferralCode('org-1')).resolves.toEqual({
      organizationId: 'org-1',
      referralCode: 'ABCD2345EF',
    })
    expect(entityManager.update).not.toHaveBeenCalled()
  })

  it('locks the organization row, generates a code, and persists only that code', async () => {
    const { service, entityManager } = makeService(organization({ referralCode: null, suspended: false }))

    const result = await service.getReferralCode('org-1')

    expect(result.referralCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
    expect(entityManager.findOne).toHaveBeenCalledWith(Organization, {
      where: { id: 'org-1' },
      lock: { mode: 'pessimistic_write' },
    })
    expect(entityManager.update).toHaveBeenCalledWith(Organization, 'org-1', {
      referralCode: result.referralCode,
    })
  })

  it('retries a referral-code collision in a fresh transaction', async () => {
    const { service, organizationRepository, entityManager } = makeService(
      organization({ referralCode: null, suspended: false }),
    )
    entityManager.update.mockRejectedValueOnce({
      driverError: { code: '23505', constraint: 'organization_referral_code_uq' },
    })

    await service.getReferralCode('org-1')

    expect(organizationRepository.manager.transaction).toHaveBeenCalledTimes(2)
    expect(entityManager.update).toHaveBeenCalledTimes(2)
  })

  it('does not retry unrelated storage failures', async () => {
    const { service, organizationRepository, entityManager } = makeService(
      organization({ referralCode: null, suspended: false }),
    )
    const failure = { driverError: { code: '23505', constraint: 'unrelated_constraint' } }
    entityManager.update.mockRejectedValue(failure)

    await expect(service.getReferralCode('org-1')).rejects.toBe(failure)
    expect(organizationRepository.manager.transaction).toHaveBeenCalledTimes(1)
  })

  it.each([null, organization({ referralCode: null, suspended: true, suspendedUntil: null })])(
    'rejects an unavailable organization',
    async (found) => {
      const { service, entityManager } = makeService(found)

      await expect(service.getReferralCode('org-1')).rejects.toMatchObject({
        response: { statusCode: 403, code: 'invitation_unavailable' },
      })
      expect(entityManager.update).not.toHaveBeenCalled()
    },
  )

  it('allows a temporary suspension that has expired', async () => {
    const { service } = makeService(
      organization({ referralCode: 'ABCD2345EF', suspended: true, suspendedUntil: new Date(Date.now() - 1000) }),
    )

    await expect(service.getReferralCode('org-1')).resolves.toEqual({
      organizationId: 'org-1',
      referralCode: 'ABCD2345EF',
    })
  })

  it('maps a row-lock timeout to a retryable response', async () => {
    const { service, entityManager } = makeService(organization({ referralCode: null, suspended: false }))
    entityManager.findOne.mockRejectedValue({ driverError: { code: '55P03' } })

    await expect(service.getReferralCode('org-1')).rejects.toMatchObject({
      response: { statusCode: 503, code: 'referral_code_unavailable' },
    })
  })
})

describe('OrganizationService.unsuspend', () => {
  it('unsuspends unconditionally when no ifReason is given', async () => {
    const { service, organizationRepository } = makeService(
      organization({ suspended: true, suspensionReason: 'abuse', suspendedAt: new Date() }),
    )

    await service.unsuspend('org-1')

    expect(organizationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ suspended: false, suspensionReason: null, suspendedAt: null }),
    )
  })

  it('unsuspends when ifReason matches the current suspension reason exactly', async () => {
    const { service, organizationRepository } = makeService(
      organization({ suspended: true, suspensionReason: 'abuse' }),
    )

    await service.unsuspend('org-1', 'abuse')

    expect(organizationRepository.save).toHaveBeenCalledWith(expect.objectContaining({ suspended: false }))
  })

  // An admin may have re-suspended for a different reason after a credit hold
  // was placed; releasing the hold must not clear that unrelated suspension.
  it('leaves the organization untouched and throws 409 when ifReason does not match', async () => {
    const { service, organizationRepository } = makeService(
      organization({ suspended: true, suspensionReason: 'manually suspended by an admin' }),
    )

    await expect(service.unsuspend('org-1', 'credits depleted')).rejects.toThrow(ConflictException)
    expect(organizationRepository.save).not.toHaveBeenCalled()
  })

  // suspensionReason is free text an admin or support agent wrote — a caller probing with
  // guessed ifReason values must not be able to read it back out of the error.
  it('does not leak the stored suspension reason into the 409 message', async () => {
    const { service } = makeService(
      organization({ suspended: true, suspensionReason: 'flagged for suspected abuse by support' }),
    )

    await expect(service.unsuspend('org-1', 'credits depleted')).rejects.toMatchObject({
      message: expect.not.stringContaining('flagged for suspected abuse by support'),
    })
  })

  it('leaves the organization untouched and throws 409 when ifReason is given but the org is not suspended', async () => {
    const { service, organizationRepository } = makeService(organization())

    await expect(service.unsuspend('org-1', 'credits depleted')).rejects.toThrow(ConflictException)
    expect(organizationRepository.save).not.toHaveBeenCalled()
  })

  it('throws 404 for an unknown organization', async () => {
    const { service } = makeService(null)

    await expect(service.unsuspend('missing')).rejects.toThrow(NotFoundException)
  })
})

describe('OrganizationService.handleUserEmailVerifiedEvent', () => {
  const verificationReason = 'Please verify your email address'

  const eventContext = (found: Organization) => {
    const entityManager = {
      findOne: jest.fn().mockResolvedValue({ organization: found }),
      save: jest.fn().mockImplementation((org: Organization) => Promise.resolve(org)),
    }
    const { service } = makeService(null)
    return { service, entityManager, payload: { entityManager, userId: 'user-1' } as any }
  }

  it('clears the default organization suspension created by email verification', async () => {
    const suspendedAt = new Date()
    const { service, entityManager, payload } = eventContext(
      organization({ suspended: true, suspensionReason: verificationReason, suspendedAt }),
    )

    await service.handleUserEmailVerifiedEvent(payload)

    expect(entityManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ suspended: false, suspensionReason: null, suspendedAt: null }),
    )
  })

  it('preserves an unrelated administrator or billing suspension', async () => {
    const suspended = organization({ suspended: true, suspensionReason: 'Payment method required' })
    const { service, entityManager, payload } = eventContext(suspended)

    await service.handleUserEmailVerifiedEvent(payload)

    expect(entityManager.save).not.toHaveBeenCalled()
    expect(suspended).toMatchObject({ suspended: true, suspensionReason: 'Payment method required' })
  })

  it('does nothing when the organization is already active', async () => {
    const { service, entityManager, payload } = eventContext(organization())

    await service.handleUserEmailVerifiedEvent(payload)

    expect(entityManager.save).not.toHaveBeenCalled()
  })
})

describe('OrganizationService.assertOrganizationIsNotSuspended', () => {
  it('does not throw for an active organization', () => {
    const { service } = makeService(organization())

    expect(() => service.assertOrganizationIsNotSuspended(organization())).not.toThrow()
  })

  // suspensionReason is free text an admin or support agent wrote and may describe a case
  // (e.g. a fraud investigation) in more detail than "you are suspended" should disclose.
  it('does not leak the stored suspension reason to the suspended organization itself', () => {
    const { service } = makeService(organization())
    const suspended = organization({ suspended: true, suspensionReason: 'flagged for suspected abuse by support' })

    expect(() => service.assertOrganizationIsNotSuspended(suspended)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('flagged for suspected abuse by support'),
      }),
    )
  })

  it('does not throw once a temporary suspension has expired', () => {
    const { service } = makeService(organization())
    const expired = organization({ suspended: true, suspendedUntil: new Date(Date.now() - 1000) })

    expect(() => service.assertOrganizationIsNotSuspended(expired)).not.toThrow()
  })
})
