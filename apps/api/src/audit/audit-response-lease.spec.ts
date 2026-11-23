import { AuditService } from './services/audit.service'

describe('response audit lease lifecycle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  function setup() {
    const query = jest.fn().mockResolvedValue([[{ id: 'audit' }], 1])
    const service = new AuditService({} as never, { get: () => false } as never, {} as never, {} as never, {} as never)
    // The deadline mechanism has its own database/connection tests; control writes at its boundary here.
    jest
      .spyOn(service as any, 'writeWithDeadline')
      .mockImplementation(async (_deadline, operation: any) => operation({ query }))
    return { service, query }
  }

  it('stops renewal synchronously and completes only once after an in-flight renewal', async () => {
    const { service, query } = setup()
    const lease = await service.keepPendingLogAlive('audit')
    let release!: (rows: unknown) => void
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await jest.advanceTimersByTimeAsync(60_000)
    await jest.advanceTimersByTimeAsync(120_000)
    expect(query).toHaveBeenCalledTimes(2)
    const completion = lease.complete({ statusCode: 204 })
    expect(lease.complete({ statusCode: 500 })).toBe(completion)
    expect(jest.getTimerCount()).toBe(0)
    expect(query).toHaveBeenCalledTimes(2)
    release([[{ id: 'audit' }], 1])
    await completion
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[2][1][1]).toBe(204)
    await jest.advanceTimersByTimeAsync(120_000)
    expect(query).toHaveBeenCalledTimes(3)
  })

  it.each([false, true])(
    'aborts on failed renewal without deadlocking completion (terminal failure: %s)',
    async (terminalFailure) => {
      const { service, query } = setup()
      const lease = await service.keepPendingLogAlive('audit')
      query.mockRejectedValueOnce(new Error('connection lost'))
      if (terminalFailure) query.mockRejectedValueOnce(new Error('terminal write failed'))
      let outcome: string | undefined
      lease.signal.addEventListener('abort', () => {
        void lease.complete({ statusCode: 0 }).then(
          () => {
            outcome = 'completed'
          },
          () => {
            outcome = 'failed'
          },
        )
      })
      await jest.advanceTimersByTimeAsync(60_000)
      expect(lease.signal.aborted).toBe(true)
      expect(outcome).toBe(terminalFailure ? 'failed' : 'completed')
      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(120_000)
      expect(query).toHaveBeenCalledTimes(3)
    },
  )

  it('does not start a timer when acquisition fails', async () => {
    const { service, query } = setup()
    query.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(service.keepPendingLogAlive('audit')).rejects.toThrow('database unavailable')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('stops renewal even when the terminal update loses its lease', async () => {
    const { service, query } = setup()
    const lease = await service.keepPendingLogAlive('audit')
    query.mockResolvedValueOnce([[], 0])
    await expect(lease.complete({ statusCode: 204 })).rejects.toThrow('lease lost')
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(120_000)
    expect(query).toHaveBeenCalledTimes(2)
  })
})
