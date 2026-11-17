import { AuditAction } from './enums/audit-action.enum'
import { AuditService } from './services/audit.service'
import { AuditLog } from './entities/audit-log.entity'
import { ExecutionContext, Logger } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, of } from 'rxjs'
import { EventEmitter } from 'node:events'
import { AuditInterceptor } from './interceptors/audit.interceptor'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('audit write deadlines', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  function setup() {
    const client = { end: jest.fn(async () => undefined), connection: { stream: { destroy: jest.fn() } } }
    const repo = {
      insert: jest.fn(async () => undefined),
      findOne: jest.fn(async () => new AuditLog({ actorId: 'actor', actorEmail: '', action: AuditAction.ATTACH })),
      save: jest.fn(async (row: AuditLog) => row),
      query: jest.fn(async () => [[{ id: 'audit' }], 1]),
    }
    const runner = {
      connect: jest.fn(async () => client),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true
      }),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false
      }),
      rollbackTransaction: jest.fn(async () => {
        runner.isTransactionActive = false
      }),
      query: jest.fn(async () => []),
      release: jest.fn(async () => undefined),
      isTransactionActive: false,
      manager: { getRepository: () => repo },
    }
    const config = { get: () => false }
    const service = new AuditService(
      { ...repo, manager: { connection: { createQueryRunner: () => runner } } } as never,
      config as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const write = () => service.createLog({ actorId: 'actor', actorEmail: '', action: AuditAction.ATTACH }, 100)
    return { client, repo, runner, write, service, config }
  }

  function request(service: AuditService, completion = 'response') {
    const response = Object.assign(new EventEmitter(), { statusCode: 201, destroyed: false })
    const interceptor = new AuditInterceptor(
      { get: () => ({ action: AuditAction.ATTACH, completion }) } as unknown as Reflector,
      service,
    )
    const incoming = { user: { userId: 'actor', email: '', organizationId: 'org' }, get: () => undefined }
    const context = {
      getHandler: () => undefined,
      switchToHttp: () => ({ getRequest: () => incoming, getResponse: () => response }),
    } as unknown as ExecutionContext
    const next = { handle: jest.fn(() => of('executed')) }
    const result = firstValueFrom(interceptor.intercept(context, next))
    return { response, next, result }
  }

  it('returns by the deadline and destroys a stuck database connection', async () => {
    const { repo, client, runner, write } = setup()
    const gate = deferred()
    repo.insert.mockImplementation(() => gate.promise)
    let outcome = 'pending'
    const work = write().then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await jest.advanceTimersByTimeAsync(101)
      expect(outcome).toBe('failed')
      expect(client.end).toHaveBeenCalledTimes(1)
      expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1)
      expect(runner.rollbackTransaction).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await work
    }
  })

  it('releases late acquisition without running SQL or releasing before connect settles', async () => {
    const { repo, runner, client, write } = setup()
    const gate = deferred()
    runner.connect.mockImplementation(async () => {
      await gate.promise
      return client
    })
    let outcome = 'pending'
    const work = write().then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await jest.advanceTimersByTimeAsync(101)
      expect(outcome).toBe('failed')
      expect(runner.release).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await work
    }
    expect(repo.insert).not.toHaveBeenCalled()
    expect(runner.startTransaction).not.toHaveBeenCalled()
    expect(runner.release).toHaveBeenCalledTimes(1)
  })

  it.each([20, 50, 100])('allows %i writes to wait for connections instead of rejecting at eight', async (count) => {
    const { runner, client, write } = setup()
    const gate = deferred()
    runner.connect.mockImplementation(async () => {
      await gate.promise
      return client
    })
    const works = Promise.allSettled(Array.from({ length: count }, () => write()))
    try {
      await jest.advanceTimersByTimeAsync(10)
      expect(runner.connect).toHaveBeenCalledTimes(count)
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await works
    }
    expect((await works).every((result) => result.status === 'fulfilled')).toBe(true)
  })

  it('uses only the remaining budget for SQL after waiting for a connection', async () => {
    const { runner, client, write } = setup()
    const gate = deferred()
    runner.connect.mockImplementation(async () => {
      await gate.promise
      return client
    })
    const work = write()
    await jest.advanceTimersByTimeAsync(70)
    gate.resolve()
    await work
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('statement_timeout'), ['30ms', '30ms'])
  })

  it.each(['insert', 'lease'])(
    'bounds pre-handler %s by a shared five-second deadline and returns 503',
    async (stage) => {
      const { service, repo } = setup()
      const gate = deferred()
      if (stage === 'insert') repo.insert.mockImplementation(() => gate.promise)
      else {
        repo.insert.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 4000)))
        repo.query.mockImplementation(async () => {
          await gate.promise
          return [[{ id: 'audit' }], 1]
        })
      }
      const { response, next, result } = request(service)
      let status: number | undefined
      const work = result.catch((error) => {
        status = error.getStatus()
      })
      try {
        await jest.advanceTimersByTimeAsync(5001)
        expect(status).toBe(503)
        expect(next.handle).not.toHaveBeenCalled()
      } finally {
        gate.resolve()
        await jest.advanceTimersByTimeAsync(0)
        await work
        response.emit('finish')
        await jest.advanceTimersByTimeAsync(0)
      }
    },
  )

  it('refuses forwarding when the clock expires before the deadline timer runs', async () => {
    const { service } = setup()
    const acquire = service.keepPendingLogAlive.bind(service)
    jest.spyOn(service, 'keepPendingLogAlive').mockImplementation(async (...args) => {
      const lease = await acquire(...args)
      jest.spyOn(performance, 'now').mockReturnValue(6000)
      return lease
    })
    const { next, result } = request(service)
    await expect(result).rejects.toMatchObject({ status: 503 })
    expect(next.handle).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('preserves handler success when recording its result times out', async () => {
    const { service, repo } = setup()
    const gate = deferred()
    repo.save.mockImplementation(async (row) => {
      await gate.promise
      return row
    })
    const { next, result } = request(service, 'handler')
    let outcome: unknown
    const work = result.then((value) => {
      outcome = value
    })
    try {
      await jest.advanceTimersByTimeAsync(5001)
      expect(outcome).toBe('executed')
      expect(next.handle).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await work
    }
  })

  it.each(['57014', '55P03', '23505'])('classifies SQLSTATE %s without hiding unexpected failures', async (code) => {
    const { service, repo } = setup()
    const cause = Object.assign(new Error('database failure'), { code })
    repo.insert.mockRejectedValue(cause)
    const { next, result } = request(service)
    await expect(result).rejects.toMatchObject({ status: code === '23505' ? 500 : 503 })
    expect(next.handle).not.toHaveBeenCalled()
  })

  it('keeps the deadline active while rollback is stuck', async () => {
    const { repo, runner, client, write } = setup()
    const gate = deferred()
    repo.insert.mockRejectedValue(new Error('write failed'))
    runner.rollbackTransaction.mockImplementation(() => gate.promise)
    let outcome = 'pending'
    const work = write().then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await jest.advanceTimersByTimeAsync(101)
      expect(outcome).toBe('failed')
      expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await work
    }
    expect(runner.release).toHaveBeenCalledTimes(1)
  })

  it('does not save after a timed-out lookup, including when the connection is idle', async () => {
    const { service, repo, client, runner } = setup()
    const gate = deferred()
    repo.findOne.mockImplementation(async () => {
      await gate.promise
      return new AuditLog({ actorId: 'actor', actorEmail: '', action: AuditAction.ATTACH })
    })
    let outcome = 'pending'
    const work = service.updateLog('id', { statusCode: 101 }, 100).then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await jest.advanceTimersByTimeAsync(101)
      expect(outcome).toBe('failed')
      expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await work
    }
    expect(repo.save).not.toHaveBeenCalled()
    expect(runner.release).toHaveBeenCalledTimes(1)
  })

  it('does not emit a completed console entry before a bounded commit succeeds', async () => {
    const { service, config, runner } = setup()
    config.get = () => true
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation()
    const gate = deferred()
    runner.commitTransaction.mockImplementation(() => gate.promise)
    const work = service.updateLog('id', { statusCode: 101 }, 100).catch(() => undefined)
    try {
      await jest.advanceTimersByTimeAsync(101)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await work
    }
    expect(logged).not.toHaveBeenCalled()
    expect(runner.rollbackTransaction).not.toHaveBeenCalled()
  })

  it('classifies acquisition failures and clears timers without releasing an unacquired runner', async () => {
    const { runner, write } = setup()
    const cause = new Error('cannot acquire')
    runner.connect.mockRejectedValue(cause)
    for (let attempt = 0; attempt < 10; attempt++) await expect(write()).rejects.toMatchObject({ status: 503, cause })
    expect(runner.release).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })
})
