/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeDemand } from './demand'
import { ExecutionScope } from './execution/model'
import { WorkflowJob } from './jobs'
import { NotifiedDemand } from './notified-demand'
import { SqliteStateDatabase } from './state/sqlite'
import { ListenerState, ExecutionLease } from './state/store'
import { StateConflict } from './state/database'

describe('CI notified positive evidence', () => {
  const scope: ExecutionScope = {
    binding: 'binding',
    generation: 1,
    organization: 'tenant',
    actor: 'owner',
    installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
    runners: {
      kind: 'repository',
      repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
      allowPrivate: true,
      allowPublic: false,
    },
  }
  const notice = { repository: 21, run: 33, job: 55 }
  const job: WorkflowJob = { ...notice, status: 'queued', runner: null, labels: ['boxlite'] }
  let directory: string, db: SqliteStateDatabase, state: ListenerState, lease: ExecutionLease, evidence: NotifiedDemand
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-positive-'))
    db = new SqliteStateDatabase(directory)
    state = new ListenerState(db, 'app:' + randomUUID())
    await state.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    evidence = new NotifiedDemand(state, lease, ['boxlite'])
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const verify = () => evidence.read(scope, [notice], async () => [job])
  it('removes cached queued evidence when a persisted completion changes its fact', async () => {
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
    await state.ingress('1/21', async (tx) => {
      await tx.write(
        await observeDemand(
          tx,
          { installationId: 1, accountId: 7, repositoryId: 21, job: { id: 55, runId: 33 } },
          { status: 'completed', runner: null, labels: ['boxlite'] },
        ),
      )
    })
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([])
  })
  it('requires another GitHub observation after the positive evidence deadline', async () => {
    let now = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
    now += 30000
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
  })
  it.each(['in_progress', 'completed'] as const)(
    'does not count a newly observed %s job as capacity demand',
    async (status) => {
      await verify()
      expect(
        await evidence.read(scope, [notice], async () => [
          { ...job, status, runner: status === 'in_progress' ? 91 : null },
        ]),
      ).toEqual([])
    },
  )
  it.each([{ repository: 22 }, { run: 34 }, { job: 56 }])(
    'rejects a backend response with changed identity %j',
    async (change) => {
      await expect(evidence.read(scope, [notice], async () => [{ ...job, ...change }])).rejects.toThrow(
        'identity changed',
      )
      expect(await evidence.read(scope, [], async () => [])).toEqual([])
    },
  )
  it('ignores notices outside the original repository before invoking the reader', async () => {
    const read = jest.fn(async () => [job])
    expect(await evidence.read(scope, [{ ...notice, repository: 22 }], read)).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
  it('invalidates positive evidence after a complete background correction', async () => {
    await verify()
    await evidence.invalidate(1, 21)
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
  })
  it('does not renew evidence that aged while GitHub lookups were pending', async () => {
    let now = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    expect(
      await evidence.read(scope, [notice], async () => {
        now += 31000
        return [job]
      }),
    ).toEqual([])
  })
  it('rejects a read begun before invalidation and permits a new observation', async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reading = evidence.read(scope, [notice], async () => {
      entered()
      await held
      return [job]
    })
    const rejected = expect(reading).rejects.toBeInstanceOf(StateConflict)
    await started
    await evidence.invalidate(1, 21)
    release()
    await rejected
    expect(await state.read(['job-fact/1/55'], lease)).toEqual([])
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
  })
})
