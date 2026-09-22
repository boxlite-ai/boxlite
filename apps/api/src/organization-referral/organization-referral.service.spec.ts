import { OrganizationReferralService } from './organization-referral.service'
import { Organization } from '../organization/entities/organization.entity'

describe('Organization invitation code initialization', () => {
  function fixture(organization: Partial<Organization> | null) {
    const em = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(organization),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const service = new OrganizationReferralService({ transaction: (callback) => callback(em) } as never)
    return { service, em }
  }

  it('returns an existing code without modifying any attribution', async () => {
    const { service, em } = fixture({ id: 'org', referralCode: 'ABCD2345EF', suspended: false })
    expect(await service.getCode('org')).toEqual({ organizationId: 'org', referralCode: 'ABCD2345EF' })
    expect(em.update).not.toHaveBeenCalled()
  })

  it('generates and persists only the sharing code', async () => {
    const { service, em } = fixture({ id: 'org', referralCode: null, suspended: false })
    const result = await service.getCode('org')
    expect(result.referralCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
    expect(em.update).toHaveBeenCalledWith(Organization, 'org', { referralCode: result.referralCode })
  })

  it('retries only the referral-code unique constraint after rolling back a savepoint', async () => {
    const { service, em } = fixture({ id: 'org', suspended: false })
    em.update.mockRejectedValueOnce({ driverError: { code: '23505', constraint: 'organization_referral_code_uq' } })
    await service.getCode('org')
    expect(em.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT referral_code_attempt')
    expect(em.update).toHaveBeenCalledTimes(2)
  })

  it('propagates unrelated storage failures instead of retrying them as code collisions', async () => {
    const { service, em } = fixture({ id: 'org', suspended: false })
    const failure = { driverError: { code: '23505', constraint: 'unrelated_constraint' } }
    em.update.mockRejectedValue(failure)
    await expect(service.getCode('org')).rejects.toBe(failure)
    expect(em.update).toHaveBeenCalledTimes(1)
  })

  it.each([null, { id: 'org', suspended: true, suspendedUntil: null }])(
    'rejects unavailable organizations',
    async (organization) => {
      const { service, em } = fixture(organization)
      await expect(service.getCode('org')).rejects.toMatchObject({ response: { code: 'invitation_unavailable' } })
      expect(em.update).not.toHaveBeenCalled()
    },
  )
})
