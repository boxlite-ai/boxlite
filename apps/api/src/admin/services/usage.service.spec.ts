import { randomUUID } from 'crypto'
import { parseUsageRequest, usageCursor } from '../utils/usage-query'
import { AdminUsageService } from './usage.service'

describe('AdminUsageService failure handling', () => {
  const request = (cursor?: string) =>
    parseUsageRequest({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      ...(cursor ? { cursor } : {}),
    })
  const auth = { userId: 'test-admin' } as never

  it('does not mask database failures as missing data or expose raw source messages', async () => {
    const service = new AdminUsageService(
      { transaction: jest.fn().mockRejectedValue(new Error('sensitive DB failure')) } as never,
      {} as never,
    )
    await expect(service.query(request(), auth)).rejects.toMatchObject({
      status: 503,
      response: { code: 'usage_source_unavailable', message: 'Usage source unavailable' },
    })
  })

  it.each(['offline', 'corrupt'])(
    'fails closed on %s Redis continuation without querying the database',
    async (mode) => {
      const transaction = jest.fn()
      const get =
        mode === 'offline'
          ? jest.fn().mockRejectedValue(new Error('Redis offline'))
          : jest.fn().mockResolvedValue('{"broken":true}')
      const service = new AdminUsageService({ transaction } as never, { get } as never)
      await expect(service.query(request(usageCursor(randomUUID(), 1)), auth)).rejects.toMatchObject({ status: 503 })
      expect(transaction).not.toHaveBeenCalled()
    },
  )

  it('rejects a malformed cursor before any cache or database access', async () => {
    const get = jest.fn()
    const transaction = jest.fn()
    const service = new AdminUsageService({ transaction } as never, { get } as never)
    await expect(service.query(request('not-json'), auth)).rejects.toMatchObject({ status: 400 })
    expect(get).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('does not return a first page if Redis cannot save its snapshot', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ periodCount: 0, invalid: false, items: [] }]),
    }
    const transaction = jest.fn((callback) => callback(manager))
    const set = jest.fn().mockRejectedValue(new Error('Redis unavailable'))
    const service = new AdminUsageService({ transaction } as never, { set } as never)
    await expect(service.query(request(), auth)).rejects.toMatchObject({ status: 503 })
    expect(set).toHaveBeenCalledTimes(1)
  })
})
