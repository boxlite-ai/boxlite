import { Injectable } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { Organization } from '../organization/entities/organization.entity'
import { REFERRAL_ALPHABET, REFERRAL_UNIQUE_CONSTRAINT, RegistrationException, isLockTimeout } from './referral-code'

@Injectable()
export class OrganizationReferralService {
  constructor(private readonly dataSource: DataSource) {}

  async getCode(organizationId: string): Promise<{ organizationId: string; referralCode: string }> {
    try {
      return await this.dataSource.transaction(async (em) => {
        await em.query("SET LOCAL lock_timeout = '5s'")
        const organization = await em.findOne(Organization, {
          where: { id: organizationId },
          lock: { mode: 'pessimistic_write' },
        })
        if (!this.isAvailable(organization)) throw new RegistrationException(403, 'invitation_unavailable')
        if (organization.referralCode) return { organizationId, referralCode: organization.referralCode }

        for (let attempt = 0; attempt < 5; attempt++) {
          const referralCode = this.generateCode()
          await em.query('SAVEPOINT referral_code_attempt')
          try {
            await em.update(Organization, organizationId, { referralCode })
            await em.query('RELEASE SAVEPOINT referral_code_attempt')
            return { organizationId, referralCode }
          } catch (error) {
            await em.query('ROLLBACK TO SAVEPOINT referral_code_attempt')
            await em.query('RELEASE SAVEPOINT referral_code_attempt')
            const failure = error.driverError ?? error
            if (failure.code !== '23505' || failure.constraint !== REFERRAL_UNIQUE_CONSTRAINT) throw error
          }
        }
        throw new RegistrationException(503, 'referral_code_unavailable')
      })
    } catch (error) {
      if (isLockTimeout(error)) throw new RegistrationException(503, 'referral_code_unavailable')
      throw error
    }
  }

  /** Keeps an inviter from being suspended/deleted between validation and commit. */
  async resolveInviter(em: EntityManager, referralCode: string): Promise<Organization> {
    const inviter = await em.findOne(Organization, {
      where: { referralCode },
      lock: { mode: 'pessimistic_read' },
    })
    if (!this.isAvailable(inviter)) throw new RegistrationException(422, 'invitation_unavailable')
    return inviter
  }

  isAvailable(organization: Organization | null): organization is Organization {
    return (
      !!organization &&
      (!organization.suspended ||
        (!!organization.suspendedUntil && organization.suspendedUntil.getTime() <= Date.now()))
    )
  }

  private generateCode(): string {
    return Array.from({ length: 10 }, () => REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)]).join('')
  }
}
