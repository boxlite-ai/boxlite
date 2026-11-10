/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionScope } from '../execution/model'
import { GitHubRequestError } from '../github'
import { SqliteStateDatabase } from '../state/sqlite'
import { ListenerState } from '../state/store'
import { RepositoryCompensation, RepositoryScanSession } from './scanner'
import { RepositoryScanQueue, ScanClaim } from './queue'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe('CI independent compensation lanes', () => {
  let directory: string, database: SqliteStateDatabase, state: ListenerState, queue: RepositoryScanQueue
  let stop: AbortController, report: jest.Mock, leases: ScanClaim[]
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-scan-lanes-'))
    database = new SqliteStateDatabase(directory)
    state = new ListenerState(database, 'scans')
    queue = state.scans()
    stop = new AbortController()
    report = jest.fn()
    leases = []
    await state.initialize()
    const main = (await state.acquire('main', 300000))!
    for (let id = 1; id <= 3; id++) {
      const scope: ExecutionScope = {
        binding: 'binding-' + id,
        generation: 1,
        organization: 'tenant',
        actor: 'actor',
        installation: { id, account: { id, login: 'owner', type: 'User' } },
        runners: {
          kind: 'repository',
          repository: { id, owner: { id, login: 'owner' }, name: 'repo', private: true },
          allowPublic: false,
        },
      }
      await queue.synchronize(main, 'app', scope.binding, [scope])
    }
  })
  afterEach(async () => {
    stop.abort()
    await database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const run = (open: (claim: ScanClaim, signal: AbortSignal) => Promise<RepositoryScanSession>) =>
    new RepositoryCompensation({ queue, open, report, wake: jest.fn(), tickMs: 1, intervalMs: 300000 })

  it('holds at most two scans, claims the third only after release, and closes all sessions on stop', async () => {
    const entered = deferred(),
      third = deferred(),
      release = deferred()
    let active = 0,
      maximum = 0,
      closed = 0
    const worker = run(async (claim) => {
      leases.push(claim)
      return {
        queued: async (signal) => {
          active++
          maximum = Math.max(maximum, active)
          if (leases.length === 2) entered.resolve()
          if (leases.length === 3) third.resolve()
          try {
            await new Promise<void>((resolve) => {
              const finish = () => {
                signal.removeEventListener('abort', finish)
                resolve()
              }
              signal.addEventListener('abort', finish, { once: true })
              release.promise.then(finish)
            })
            signal.throwIfAborted()
            return []
          } finally {
            active--
          }
        },
        publish: async () => {},
        close: async () => {
          closed++
        },
      }
    })
    const running = worker.run(stop.signal)
    try {
      await entered.promise
      expect(leases).toHaveLength(2)
      release.resolve()
      await third.promise
    } finally {
      stop.abort()
      release.resolve()
      await running
    }
    expect(maximum).toBe(2)
    expect(closed).toBe(3)
    expect(report).not.toHaveBeenCalled()
  })
  it('persists shared rate-limit backoff while scanning another installation', async () => {
    const completed = deferred()
    let limited: ScanClaim | undefined
    const worker = run(async (claim) => {
      leases.push(claim)
      return {
        queued: async () => {
          if (!limited) {
            limited = claim
            throw new GitHubRequestError(429, false, Date.now() + 120000)
          }
          return []
        },
        publish: async () => {},
        close: async () => {
          if (leases.length >= 3) completed.resolve()
        },
      }
    })
    const running = worker.run(stop.signal)
    try {
      await completed.promise
    } finally {
      stop.abort()
      await running
    }
    expect(new Set(leases.map((claim) => claim.scope.installation.id)).size).toBe(3)
    expect(report).toHaveBeenCalledWith(expect.any(GitHubRequestError), 'compensation')
    expect(await queue.claim('another-replica')).toBeUndefined()
  })
  it('retries failed credential retirement before reusing that lane', async () => {
    const closed = deferred(),
      reported = deferred(),
      failure = new Error('revoke unavailable')
    report.mockImplementation(() => reported.resolve())
    const close = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const worker = run(async (claim) => ({
      queued: async () => [],
      publish: async () => {},
      close: async () => {
        await close()
        closed.resolve()
      },
    }))
    const running = worker.run(stop.signal)
    try {
      await Promise.all([closed.promise, reported.promise])
    } finally {
      stop.abort()
      await running
    }
    expect(close.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(report).toHaveBeenCalledWith(failure, 'compensation')
  })
})
