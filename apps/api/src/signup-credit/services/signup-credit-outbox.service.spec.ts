import { UserCreationSource } from '../../user/enums/user-creation-source.enum'
import {
  SignupCreditEligibilityKind,
  SignupCreditOutbox,
  SignupCreditOutboxStatus,
} from '../entities/signup-credit-outbox.entity'
import { SignupCreditOutboxService, signupCreditEventKey } from './signup-credit-outbox.service'

function harness(amountCents = 10_000) {
  const execute = jest.fn().mockResolvedValue({ raw: [{ eventKey: 'inserted' }] })
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['insert', 'into', 'values', 'orIgnore']) {
    builder[method] = jest.fn().mockReturnValue(builder)
  }
  builder.execute = execute
  const entityManager = {
    createQueryBuilder: jest.fn().mockReturnValue(builder),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  }
  const repository = { delete: jest.fn().mockResolvedValue({ affected: 2 }) }
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'signupCredit.amountCents') return amountCents
      throw new Error(`unexpected config key ${key}`)
    }),
  }
  const service = new SignupCreditOutboxService(repository as never, configService as never)
  return { service, entityManager, repository, builder, execute, configService }
}

describe('SignupCreditOutboxService', () => {
  it.each([
    [true, SignupCreditOutboxStatus.PENDING, SignupCreditEligibilityKind.REGISTERED_VERIFIED],
    [false, SignupCreditOutboxStatus.AWAITING_VERIFICATION, null],
  ])('snapshots an OIDC signup (verified=%s)', async (isEmailVerified, status, eligibilityKind) => {
    const { service, entityManager, builder } = harness()

    await expect(
      service.enqueueForDefaultOrganization(
        entityManager as never,
        '11111111-1111-4111-8111-111111111111',
        UserCreationSource.OIDC,
        isEmailVerified,
      ),
    ).resolves.toBe(true)

    expect(builder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: signupCreditEventKey('11111111-1111-4111-8111-111111111111'),
        organizationId: '11111111-1111-4111-8111-111111111111',
        payload: { schemaVersion: 1, amountCents: 10_000 },
        status,
        eligibilityKind,
        eligibleAt: isEmailVerified ? expect.any(Date) : null,
      }),
    )
  })

  it.each([UserCreationSource.ADMIN_API, UserCreationSource.SYSTEM_BOOTSTRAP])(
    'does not enqueue source %s',
    async (source) => {
      const { service, entityManager } = harness()
      await expect(service.enqueueForDefaultOrganization(entityManager as never, 'org', source, true)).resolves.toBe(
        false,
      )
      expect(entityManager.createQueryBuilder).not.toHaveBeenCalled()
    },
  )

  it('does not enqueue while the configured amount is zero', async () => {
    const { service, entityManager } = harness(0)
    await expect(
      service.enqueueForDefaultOrganization(entityManager as never, 'org', UserCreationSource.OIDC, true),
    ).resolves.toBe(false)
    expect(entityManager.createQueryBuilder).not.toHaveBeenCalled()
  })

  it('only advances an existing awaiting row and never rebuilds its payload from current config', async () => {
    const { service, entityManager, configService } = harness(0)
    await expect(service.markVerified(entityManager as never, 'org-1')).resolves.toBe(true)

    expect(entityManager.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      { organizationId: 'org-1', status: SignupCreditOutboxStatus.AWAITING_VERIFICATION },
      expect.objectContaining({
        status: SignupCreditOutboxStatus.PENDING,
        eligibilityKind: SignupCreditEligibilityKind.VERIFIED_LATER,
        eligibleAt: expect.any(Date),
      }),
    )
    expect(entityManager.update.mock.calls[0][2]).not.toHaveProperty('payload')
    expect(configService.get).not.toHaveBeenCalled()
  })

  it('treats a verification event with no awaiting row as a no-op', async () => {
    const { service, entityManager } = harness()
    entityManager.update.mockResolvedValueOnce({ affected: 0 })
    await expect(service.markVerified(entityManager as never, 'historical-org')).resolves.toBe(false)
  })

  it('cancels only an awaiting row when its unverified user is deleted', async () => {
    const { service, entityManager } = harness()
    await service.cancelAwaiting(entityManager as never, 'org-1')
    expect(entityManager.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      { organizationId: 'org-1', status: SignupCreditOutboxStatus.AWAITING_VERIFICATION },
      expect.objectContaining({ status: SignupCreditOutboxStatus.CANCELLED, cancelledAt: expect.any(Date) }),
    )
  })

  it('prunes delivered and cancelled history but no live state', async () => {
    const { service, repository } = harness()
    await expect(service.pruneTerminal(30)).resolves.toBe(2)
    const criteria = repository.delete.mock.calls[0][0]
    expect(criteria.map((item: { status: SignupCreditOutboxStatus }) => item.status)).toEqual([
      SignupCreditOutboxStatus.DELIVERED,
      SignupCreditOutboxStatus.CANCELLED,
    ])
  })
})
