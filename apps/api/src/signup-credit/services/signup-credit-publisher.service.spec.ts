jest.mock('axios', () => ({
  __esModule: true,
  default: {
    put: jest.fn(),
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
  },
}))

import axios from 'axios'
import { SIGNUP_CREDIT_LOCK_TIMEOUT_MS } from '../../config/configuration'
import {
  SignupCreditEligibilityKind,
  SignupCreditOutbox,
  SignupCreditOutboxStatus,
} from '../entities/signup-credit-outbox.entity'
import { SignupCreditPublisherService } from './signup-credit-publisher.service'

const put = axios.put as jest.Mock
const CONFIG: Record<string, unknown> = {
  'signupCredit.deliveryEnabled': true,
  'signupCredit.url': 'https://commerce.test',
  'signupCredit.token': 'signup-token',
  'signupCredit.batchSize': 50,
  'signupCredit.concurrency': 10,
  'signupCredit.timeoutMs': 3_000,
}

const row = (overrides: Partial<SignupCreditOutbox> = {}): SignupCreditOutbox =>
  ({
    eventKey: 'signup-credit:v1:11111111-1111-4111-8111-111111111111',
    organizationId: '11111111-1111-4111-8111-111111111111',
    payload: { schemaVersion: 1, amountCents: 10_000 },
    status: SignupCreditOutboxStatus.PENDING,
    attempts: 0,
    eligibleAt: new Date(),
    eligibilityKind: SignupCreditEligibilityKind.REGISTERED_VERIFIED,
    ...overrides,
  }) as SignupCreditOutbox

const httpError = (status?: number) => ({
  isAxiosError: true,
  message: status ? `status ${status}` : 'timeout',
  code: status ? undefined : 'ECONNABORTED',
  response: status ? { status } : undefined,
})

function harness(claimed: SignupCreditOutbox[], overrides: Record<string, unknown> = {}) {
  const update = jest.fn().mockResolvedValue({ affected: 1 })
  const entityManager = {
    query: jest.fn((sql: string, parameters: unknown[]) => {
      if (sql.startsWith('SET LOCAL')) return Promise.resolve([])
      if (sql.includes('FROM "organization"')) {
        return Promise.resolve(claimed.some((candidate) => candidate.organizationId === parameters[0]) ? [{}] : [])
      }
      return Promise.resolve(claimed.filter((candidate) => candidate.eventKey === parameters[0]))
    }),
    update,
  }
  const repository = {
    query: jest.fn().mockResolvedValue(claimed),
    update,
    manager: {
      transaction: jest.fn((work: (manager: typeof entityManager) => Promise<unknown>) => work(entityManager)),
    },
  }
  const outboxService = { pruneTerminal: jest.fn().mockResolvedValue(0) }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const configService = {
    get: jest.fn((key: string) => {
      const config = { ...CONFIG, ...overrides }
      if (!(key in config)) throw new Error(`unexpected config key ${key}`)
      return config[key]
    }),
  }
  const service = new SignupCreditPublisherService(
    repository as never,
    outboxService as never,
    redisLockProvider as never,
    configService as never,
  )
  return { service, repository, entityManager, outboxService, redisLockProvider }
}

beforeEach(() => put.mockReset())

describe('SignupCreditPublisherService', () => {
  it('skips delivery but still prunes terminal history while delivery is disabled', async () => {
    const { service, repository, outboxService } = harness([row()], { 'signupCredit.deliveryEnabled': false })
    await service.publishPendingCredits()
    expect(repository.query).not.toHaveBeenCalled()
    expect(outboxService.pruneTerminal).toHaveBeenCalledWith(30)
  })

  it('delivers the immutable payload and marks a 204 response delivered', async () => {
    const credit = row()
    const { service, repository } = harness([credit])
    put.mockResolvedValue({ status: 204 })

    await service.publishPendingCredits()

    expect(put).toHaveBeenCalledWith(
      `https://commerce.test/internal/organizations/${credit.organizationId}/signup-credit`,
      { schemaVersion: 1, amountCents: 10_000 },
      expect.objectContaining({
        timeout: 3_000,
        headers: expect.objectContaining({ authorization: 'Bearer signup-token' }),
      }),
    )
    expect(repository.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      { eventKey: credit.eventKey, status: SignupCreditOutboxStatus.PENDING },
      expect.objectContaining({ status: SignupCreditOutboxStatus.DELIVERED, deliveredAt: expect.any(Date) }),
    )
  })

  it('locks the organization before the outbox, then skips a claim deleted before that lock', async () => {
    const credit = row()
    const { service, repository, entityManager } = harness([credit])
    entityManager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await service.publishPendingCredits()

    const [timeoutSql] = entityManager.query.mock.calls[0]
    expect(timeoutSql).toContain(`lock_timeout = '${SIGNUP_CREDIT_LOCK_TIMEOUT_MS}ms'`)
    const [organizationSql, organizationParameters] = entityManager.query.mock.calls[1]
    expect(organizationSql).toContain('FROM "organization"')
    expect(organizationSql).toContain('FOR UPDATE')
    expect(organizationParameters).toEqual([credit.organizationId])
    expect(entityManager.query).toHaveBeenCalledTimes(2)
    expect(put).not.toHaveBeenCalled()
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('uses the parent-first lock order shared with organization deletion', async () => {
    const credit = row()
    const { service, entityManager } = harness([credit])
    put.mockResolvedValue({ status: 204 })

    await service.publishPendingCredits()

    expect(entityManager.query.mock.calls[0][0]).toContain('SET LOCAL lock_timeout')
    expect(entityManager.query.mock.calls[1][0]).toContain('FROM "organization"')
    expect(entityManager.query.mock.calls[2][0]).toContain('FROM "signup_credit_outbox"')
    expect(entityManager.query.mock.calls[2][0]).toContain('FOR UPDATE OF outbox')
  })

  it('bounds organization-lock waits and leaves the claim for visibility retry', async () => {
    const credit = row()
    const { service, repository, entityManager } = harness([credit])
    entityManager.query
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }))

    await expect(service.publishPendingCredits()).resolves.toBeUndefined()

    expect(put).not.toHaveBeenCalled()
    expect(repository.update).not.toHaveBeenCalled()
  })

  it.each([400, 409, 422])('blocks permanent HTTP %s responses', async (status) => {
    const { service, repository } = harness([row()])
    put.mockRejectedValue(httpError(status))
    await service.publishPendingCredits()
    expect(repository.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      expect.anything(),
      expect.objectContaining({ status: SignupCreditOutboxStatus.BLOCKED, attempts: 1 }),
    )
  })

  it('retries a non-contract 2xx response instead of acknowledging it', async () => {
    const { service, repository } = harness([row()])
    put.mockResolvedValue({ status: 200 })
    await service.publishPendingCredits()
    expect(repository.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      expect.anything(),
      expect.objectContaining({ attempts: 1, availableAt: expect.any(Date) }),
    )
    expect(repository.update.mock.calls[0][2]).not.toHaveProperty('status')
  })

  it.each([401, 403, 404, 429, 503, undefined])(
    'retries transient response %s without an attempt cap',
    async (status) => {
      const { service, repository } = harness([row({ attempts: 100 })])
      put.mockRejectedValue(httpError(status))
      await service.publishPendingCredits()
      expect(repository.update).toHaveBeenCalledWith(
        SignupCreditOutbox,
        expect.anything(),
        expect.objectContaining({ attempts: 101, availableAt: expect.any(Date) }),
      )
      expect(repository.update.mock.calls[0][2]).not.toHaveProperty('status')
    },
  )

  it('claims with SKIP LOCKED and a 30-second visibility window', async () => {
    const { service, repository } = harness([])
    await service.publishPendingCredits()
    const [sql, parameters] = repository.query.mock.calls[0]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(parameters).toEqual([30_000, SignupCreditOutboxStatus.PENDING, 50])
  })

  it('prunes terminal history while idle', async () => {
    const { service, outboxService } = harness([])
    await service.publishPendingCredits()
    expect(outboxService.pruneTerminal).toHaveBeenCalledWith(30)
  })

  it('prunes terminal history even while a delivery batch is active', async () => {
    const { service, outboxService } = harness([row()])
    put.mockResolvedValue({ status: 204 })
    await service.publishPendingCredits()
    expect(outboxService.pruneTerminal).toHaveBeenCalledWith(30)
  })

  it('reports every outbox status and the oldest pending age for alerting', async () => {
    const { service, repository } = harness([])
    repository.query.mockResolvedValueOnce([
      { status: SignupCreditOutboxStatus.PENDING, count: 2, oldestAgeMs: '1234' },
      { status: SignupCreditOutboxStatus.BLOCKED, count: 1, oldestAgeMs: null },
    ])
    const observe = jest.fn()

    await (
      service as unknown as {
        observeOutbox(result: { observe: typeof observe }): Promise<void>
      }
    ).observeOutbox({ observe })

    expect(observe).toHaveBeenCalledWith(expect.anything(), 2, { status: SignupCreditOutboxStatus.PENDING })
    expect(observe).toHaveBeenCalledWith(expect.anything(), 1, { status: SignupCreditOutboxStatus.BLOCKED })
    expect(observe).toHaveBeenCalledWith(expect.anything(), 0, {
      status: SignupCreditOutboxStatus.AWAITING_VERIFICATION,
    })
    expect(observe).toHaveBeenCalledWith(expect.anything(), 1234)
  })

  it.each([
    { previousAttempts: 0, expectedDelayMs: 5_000 },
    { previousAttempts: 11, expectedDelayMs: 15 * 60_000 },
  ])('uses exact exponential backoff with the 15-minute cap: %#', async ({ previousAttempts, expectedDelayMs }) => {
    const now = 1_800_000_000_000
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now)
    const { service, repository } = harness([row({ attempts: previousAttempts })])
    put.mockRejectedValue(httpError(503))

    await service.publishPendingCredits()

    expect(repository.update).toHaveBeenCalledWith(
      SignupCreditOutbox,
      expect.anything(),
      expect.objectContaining({
        attempts: previousAttempts + 1,
        availableAt: new Date(now + expectedDelayMs),
      }),
    )
    dateNow.mockRestore()
  })

  it('never exceeds the configured delivery concurrency', async () => {
    let active = 0
    let peak = 0
    put.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return { status: 204 }
    })
    const rows = Array.from({ length: 8 }, (_, index) =>
      row({
        eventKey: `signup-credit:v1:11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        organizationId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      }),
    )
    const { service } = harness(rows, { 'signupCredit.concurrency': 3 })

    await service.publishPendingCredits()

    expect(put).toHaveBeenCalledTimes(8)
    expect(peak).toBe(3)
  })

  it('waits for every worker before pruning, unlocking, and rethrowing a row failure', async () => {
    const credits = [
      row(),
      row({
        eventKey: 'signup-credit:v1:22222222-2222-4222-8222-222222222222',
        organizationId: '22222222-2222-4222-8222-222222222222',
      }),
    ]
    const { service, repository, outboxService, redisLockProvider, entityManager } = harness(credits, {
      'signupCredit.concurrency': 2,
    })
    const databaseFailure = new Error('synthetic row failure')
    let transactionIndex = 0
    repository.manager.transaction.mockImplementation((work: (manager: typeof entityManager) => Promise<unknown>) =>
      transactionIndex++ === 0 ? Promise.reject(databaseFailure) : work(entityManager),
    )
    let releaseHttp!: () => void
    let reachedHttp!: () => void
    const atHttp = new Promise<void>((resolve) => {
      reachedHttp = resolve
    })
    const httpRelease = new Promise<void>((resolve) => {
      releaseHttp = resolve
    })
    put.mockImplementation(async () => {
      reachedHttp()
      await httpRelease
      return { status: 204 }
    })

    const publishing = service.publishPendingCredits()
    await atHttp
    expect(outboxService.pruneTerminal).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()

    releaseHttp()
    await expect(publishing).rejects.toThrow(databaseFailure)
    expect(outboxService.pruneTerminal).toHaveBeenCalledWith(30)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('publish-signup-credits')
  })

  it('always releases the publisher lock', async () => {
    const { service, repository, redisLockProvider } = harness([row()])
    repository.query.mockRejectedValue(new Error('db unavailable'))
    await expect(service.publishPendingCredits()).rejects.toThrow('db unavailable')
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('publish-signup-credits')
  })
})
