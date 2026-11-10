import { AuditAction } from './enums/audit-action.enum'
import { AuditService } from './services/audit.service'
import { AuditLog } from './entities/audit-log.entity'
import { Logger } from '@nestjs/common'

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

  it('bounds truly unfinished acquisitions even after their callers time out', async () => {
    const { runner, client, write } = setup()
    const gate = deferred()
    runner.connect.mockImplementation(async () => {
      await gate.promise
      return client
    })
    const works = Array.from({ length: 8 }, () => write().catch(() => undefined))
    try {
      await jest.advanceTimersByTimeAsync(101)
      await expect(write()).rejects.toThrow('capacity')
      expect(runner.connect).toHaveBeenCalledTimes(8)
    } finally {
      gate.resolve()
      await jest.advanceTimersByTimeAsync(0)
      await Promise.all(works)
    }
    await expect(write()).resolves.toMatchObject({ action: AuditAction.ATTACH })
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

  it('returns capacity after acquisition failures without releasing an unacquired runner', async () => {
    const { runner, write } = setup()
    runner.connect.mockRejectedValue(new Error('cannot acquire'))
    for (let attempt = 0; attempt < 10; attempt++) await expect(write()).rejects.toThrow('cannot acquire')
    expect(runner.release).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })
})
