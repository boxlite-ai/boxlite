import { EventEmitter2 } from '@nestjs/event-emitter'
import { randomUUID } from 'node:crypto'
import { BusinessEventOutbox } from '../business-events/business-event-outbox.entity'
import { BusinessEventOutboxService } from '../business-events/business-event-outbox.service'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationService } from '../organization/services/organization.service'
import { UserEvents } from '../user/constants/user-events.constant'
import { User } from '../user/user.entity'
import { UserService } from '../user/user.service'
import { UserRegistration } from '../user/user-registration.entity'
import { UserRegistrationService } from '../user/user-registration.service'
import { OrganizationReferralService } from './organization-referral.service'

describe('Invitation attribution across user creation, organization persistence and event enqueue', () => {
  function fixture() {
    const inviter = Object.assign(new Organization(), { id: randomUUID(), referralCode: 'ABCD2345EF' })
    const organizations = new Map<string, Organization>([[inviter.id, inviter]])
    const users = new Map<string, User>()
    let registration: UserRegistration
    const events = new EventEmitter2()
    const em = {
      query: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      transaction: jest.fn(async (callback) => callback(em)),
      create: jest.fn((Entity, values) => Object.assign(new Entity(), values)),
      save: jest.fn(async (entityOrClass, value?) => {
        const entity = value ?? entityOrClass
        if (entity instanceof User) users.set(entity.id, entity)
        if (entity instanceof Organization) {
          entity.id ??= randomUUID()
          organizations.set(entity.id, entity)
        }
        if (entity instanceof UserRegistration) {
          entity.id ??= randomUUID()
          registration = entity
        }
        return entity
      }),
      findOneBy: jest.fn(async (Entity, where) => {
        if (Entity === User) return users.get(where.id) ?? null
        if (Entity === UserRegistration) return registration ?? null
        if (Entity === OrganizationUser) {
          const organization = [...organizations.values()].find((org) => org.createdBy === where.userId)
          return organization ? { organizationId: organization.id } : null
        }
        throw new Error('Unexpected lookup')
      }),
      findOne: jest.fn(async (_Entity, { where }) =>
        where.id
          ? organizations.get(where.id)
          : [...organizations.values()].find((org) => org.referralCode === where.referralCode),
      ),
      insert: jest.fn().mockResolvedValue({}),
    }
    const referrals = new OrganizationReferralService({} as never)
    const registrations = new UserRegistrationService(referrals, new BusinessEventOutboxService())
    const organizationService = new OrganizationService(
      {} as never,
      {} as never,
      events,
      { get: () => false, getOrThrow: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    events.on(UserEvents.CREATED, organizationService.handleUserCreatedEvent.bind(organizationService))
    const service = new UserService(
      {} as never,
      events,
      { transaction: em.transaction } as never,
      registrations,
      referrals,
    )
    jest
      .spyOn(service as never, 'generatePrivateKey')
      .mockResolvedValue({ privateKey: 'test', publicKey: 'test' } as never)
    return { service, em, inviter, organizations, registration: () => registration }
  }

  it('persists the resolved inviter ID on the organization and registration, and targets that ID in the event', async () => {
    const { service, em, inviter, organizations, registration } = fixture()
    await service.authenticate(
      { id: 'invitee', name: 'Invitee', emailVerified: true },
      {
        referredCode: inviter.referralCode,
        confirmInvitation: true,
      },
    )
    const record = registration()
    expect(organizations.get(record.defaultOrganizationId)).toMatchObject({
      inviterOrganizationId: inviter.id,
      referredCode: inviter.referralCode,
    })
    expect(record.inviterOrganizationId).toBe(inviter.id)
    expect(em.insert).toHaveBeenCalledWith(BusinessEventOutbox, expect.objectContaining({ organizationId: inviter.id }))
  })

  it('persists no inviter or audit code for ordinary registration', async () => {
    const { service, em, organizations, registration } = fixture()
    await service.authenticate({ id: 'ordinary', name: 'Ordinary', emailVerified: true })
    expect(organizations.get(registration().defaultOrganizationId)).toMatchObject({
      inviterOrganizationId: null,
      referredCode: null,
    })
    expect(em.insert).not.toHaveBeenCalled()
  })

  it('confirms a pending invitation by its original organization ID after the code resolves elsewhere', async () => {
    const { service, em, inviter, organizations, registration } = fixture()
    await service.authenticate(
      { id: 'pending', name: 'Pending', emailVerified: false },
      {
        referredCode: inviter.referralCode,
        confirmInvitation: true,
      },
    )
    const auditCode = inviter.referralCode
    inviter.referralCode = 'ABCDEFGH23'
    const replacement = Object.assign(new Organization(), { id: randomUUID(), referralCode: auditCode })
    organizations.set(replacement.id, replacement)
    organizations.get(registration().defaultOrganizationId).suspended = false
    em.findOne.mockClear()
    await service.authenticate({ id: 'pending', name: 'Pending', emailVerified: true }, { confirmInvitation: true })
    expect(organizations.get(registration().defaultOrganizationId)).toMatchObject({
      inviterOrganizationId: inviter.id,
      referredCode: auditCode,
    })
    expect(em.findOne.mock.calls.every(([, options]) => !('referralCode' in options.where))).toBe(true)
    expect(em.insert).toHaveBeenCalledWith(BusinessEventOutbox, expect.objectContaining({ organizationId: inviter.id }))
  })
})
