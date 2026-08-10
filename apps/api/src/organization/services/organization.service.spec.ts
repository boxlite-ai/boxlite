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

// unsuspend() only ever touches organizationRepository; the rest of the
// constructor's dependencies are unused stubs to satisfy DI.
const makeService = (found: Organization | null) => {
  const organizationRepository = {
    findOne: jest.fn().mockResolvedValue(found),
    save: jest.fn().mockImplementation((org: Organization) => Promise.resolve(org)),
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

  return { service, organizationRepository }
}

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
