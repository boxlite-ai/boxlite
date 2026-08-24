import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, LessThan, Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { UserCreationSource } from '../../user/enums/user-creation-source.enum'
import {
  SignupCreditEligibilityKind,
  SignupCreditOutbox,
  SignupCreditOutboxStatus,
} from '../entities/signup-credit-outbox.entity'

export const signupCreditEventKey = (organizationId: string): string => `signup-credit:v1:${organizationId}`

@Injectable()
export class SignupCreditOutboxService {
  constructor(
    @InjectRepository(SignupCreditOutbox)
    private readonly repository: Repository<SignupCreditOutbox>,
    private readonly configService: TypedConfigService,
  ) {}

  async enqueueForDefaultOrganization(
    entityManager: EntityManager,
    organizationId: string,
    creationSource: UserCreationSource,
    isEmailVerified: boolean,
  ): Promise<boolean> {
    const amountCents = this.configService.get('signupCredit.amountCents')
    if (creationSource !== UserCreationSource.OIDC || amountCents === 0) return false

    const now = new Date()
    const pending = isEmailVerified
    const inserted = await entityManager
      .createQueryBuilder()
      .insert()
      .into(SignupCreditOutbox)
      .values({
        eventKey: signupCreditEventKey(organizationId),
        organizationId,
        payload: { schemaVersion: 1, amountCents },
        status: pending ? SignupCreditOutboxStatus.PENDING : SignupCreditOutboxStatus.AWAITING_VERIFICATION,
        availableAt: now,
        eligibleAt: pending ? now : null,
        eligibilityKind: pending ? SignupCreditEligibilityKind.REGISTERED_VERIFIED : null,
      })
      .orIgnore()
      .execute()

    return Array.isArray(inserted.raw) && inserted.raw.length > 0
  }

  async markVerified(entityManager: EntityManager, organizationId: string): Promise<boolean> {
    const now = new Date()
    const result = await entityManager.update(
      SignupCreditOutbox,
      { organizationId, status: SignupCreditOutboxStatus.AWAITING_VERIFICATION },
      {
        status: SignupCreditOutboxStatus.PENDING,
        availableAt: now,
        eligibleAt: now,
        eligibilityKind: SignupCreditEligibilityKind.VERIFIED_LATER,
        lastError: null,
      },
    )
    return (result.affected ?? 0) > 0
  }

  async cancelAwaiting(entityManager: EntityManager, organizationId: string): Promise<boolean> {
    const result = await entityManager.update(
      SignupCreditOutbox,
      { organizationId, status: SignupCreditOutboxStatus.AWAITING_VERIFICATION },
      {
        status: SignupCreditOutboxStatus.CANCELLED,
        cancelledAt: new Date(),
        lastError: 'User deleted before email verification',
      },
    )
    return (result.affected ?? 0) > 0
  }

  async pruneTerminal(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const result = await this.repository.delete([
      { status: SignupCreditOutboxStatus.DELIVERED, deliveredAt: LessThan(cutoff) },
      { status: SignupCreditOutboxStatus.CANCELLED, cancelledAt: LessThan(cutoff) },
    ])
    return result.affected ?? 0
  }
}
