import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import { BusinessEventOutboxService } from '../business-events/business-event-outbox.service'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationReferralService } from '../organization-referral/organization-referral.service'
import { RegistrationException } from '../organization-referral/referral-code'
import { User } from './user.entity'
import { RegistrationStatus, UserRegistration } from './user-registration.entity'

@Injectable()
export class UserRegistrationService {
  private readonly logger = new Logger(UserRegistrationService.name)

  constructor(
    private readonly referrals: OrganizationReferralService,
    private readonly outbox: BusinessEventOutboxService,
  ) {}

  async record(
    em: EntityManager,
    user: User,
    inviter?: Organization,
    requireDefault = false,
  ): Promise<UserRegistration> {
    const membership = await em.findOneBy(OrganizationUser, { userId: user.id, isDefaultForUser: true })
    if (requireDefault && !membership) throw new Error('User creation did not create a default organization')
    return em.save(
      UserRegistration,
      em.create(UserRegistration, {
        userId: user.id,
        defaultOrganizationId: membership?.organizationId ?? null,
        inviterOrganizationId: inviter?.id ?? null,
        referredCode: inviter?.referralCode ?? null,
        status: inviter ? RegistrationStatus.PENDING_VERIFICATION : RegistrationStatus.NONE,
        eventId: null,
        acceptedAt: null,
      }),
    )
  }

  assertReplay(registration: UserRegistration, referredCode?: string): void {
    if (referredCode && registration.referredCode !== referredCode) {
      throw new RegistrationException(409, 'registration_already_finalized')
    }
  }

  async confirm(em: EntityManager, user: User, registration: UserRegistration): Promise<void> {
    if (registration.status !== RegistrationStatus.PENDING_VERIFICATION || !user.emailVerified) return
    const defaultOrganization = registration.defaultOrganizationId
      ? await em.findOne(Organization, {
          where: { id: registration.defaultOrganizationId },
          lock: { mode: 'pessimistic_read' },
        })
      : null
    const inviter = await em.findOne(Organization, {
      where: { id: registration.inviterOrganizationId },
      lock: { mode: 'pessimistic_read' },
    })
    if (!this.referrals.isAvailable(defaultOrganization) || !this.referrals.isAvailable(inviter)) {
      this.logger.warn({
        message: 'Invitation remains pending',
        registrationId: registration.id,
        organizationId: registration.inviterOrganizationId,
        reason: !this.referrals.isAvailable(inviter) ? 'inviter_unavailable' : 'default_organization_unavailable',
      })
      return
    }

    registration.status = RegistrationStatus.ACCEPTED
    registration.acceptedAt = new Date()
    registration.eventId = randomUUID()
    await em.save(registration)
    await this.outbox.enqueue(em, registration.inviterOrganizationId, {
      eventId: registration.eventId,
      type: 'InvitationRegistrationSucceeded',
      occurredAt: registration.acceptedAt.toISOString(),
      data: { registrationId: registration.id, inviteeUserId: user.id },
    })
  }
}
