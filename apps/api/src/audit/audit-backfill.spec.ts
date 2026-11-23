import { AuditService } from './services/audit.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'

describe('audit backfill lease', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  function setup() {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) }
    const provider = new RedisLockProvider(redis as never)
    const query = jest.fn().mockResolvedValue([])
    const transaction = jest.fn((operation) => operation({ query }))
    const service = new AuditService(
      { manager: { transaction } } as never,
      { get: () => false } as never,
      provider,
      {} as never,
      {} as never,
    )
    return { redis, query, transaction, service }
  }

  it('keeps renewing during a long run and uses one cutoff across batches', async () => {
    const { service, redis, query } = setup()
    query.mockImplementation(async (sql: string) => {
      if (!sql.startsWith('WITH')) return []
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const writes = query.mock.calls.filter(([statement]) => statement.startsWith('WITH')).length
      return Array.from({ length: writes < 10 ? 500 : 0 }, () => ({ id: 'row' }))
    })
    const work = service.resolveDanglingLogs()
    await jest.advanceTimersByTimeAsync(41000)
    await work
    expect(redis.set).toHaveBeenCalledWith('lock:AuditService.resolveDanglingLogs', expect.any(String), 'EX', 30, 'NX')
    expect(redis.eval.mock.calls.filter(([sql]) => sql.includes("redis.call('expire'"))).toHaveLength(2)
    const cutoffs = query.mock.calls.filter(([sql]) => sql.startsWith('WITH')).map(([, args]) => args[0].getTime())
    expect(cutoffs).toHaveLength(10)
    expect(new Set(cutoffs).size).toBe(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('stops before the update when ownership is lost during batch setup', async () => {
    const { service, redis, query, transaction } = setup()
    redis.eval.mockResolvedValue(0)
    query.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([]), 16000)))
    const result = service.resolveDanglingLogs().catch((error: Error) => error)
    await jest.advanceTimersByTimeAsync(17000)
    expect(await result).toBeInstanceOf(Error)
    expect(query.mock.calls.some(([sql]) => sql.startsWith('WITH'))).toBe(false)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does no database work when another worker owns the lease', async () => {
    const { redis, transaction, service } = setup()
    redis.set.mockResolvedValue(null)
    await service.resolveDanglingLogs()
    expect(transaction).not.toHaveBeenCalled()
  })
})
