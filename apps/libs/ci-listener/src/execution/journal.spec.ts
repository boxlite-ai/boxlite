/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { StateDatabase, StateConflict, StateCorrupt } from '../state/database'
import { ListenerState, ExecutionLease } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { PostgresStateDatabase, postgresStateTable } from '../state/postgres'
import { ExecutionJournal } from './journal'
import { ScopeApplications } from '../app-scopes'
import { ExecutionScope } from './model'
import { observeDemand } from '../demand'

const definition: ExecutionScope = {
  binding: 'binding-a',
  generation: 1,
  organization: 'tenant-a',
  actor: 'owner-a',
  installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
  runners: {
    kind: 'repository',
    repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
    allowPrivate: true,
    allowPublic: false,
  },
}
const demand = { repository: 21, run: 33, job: 55 },
  limits = testCapacity({ account: 1, tenant: 1 })
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.DB_HOST ? describe.skip : describe
  suite(`CI shared execution journal ${backend}`, () => {
    let db: StateDatabase,
      sqlite: SqliteStateDatabase | undefined,
      pg: DataSource | undefined,
      state: ListenerState,
      journal: ExecutionJournal,
      lease: ExecutionLease,
      key: string,
      directory: string | undefined,
      schema: string,
      namespace: string
    beforeEach(async () => {
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-journal-'))
        sqlite = new SqliteStateDatabase(directory)
        db = sqlite
      } else {
        if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
          throw new Error(`Disposable local PostgreSQL required: DB_HOST=${process.env.DB_HOST}`)
        schema = 'ci_journal_' + randomUUID().replaceAll('-', '')
        pg = await new DataSource({
          type: 'postgres',
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT || 5432),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
          extra: { options: `-c search_path=${schema},public` },
        }).initialize()
        await pg.query(`CREATE SCHEMA "${schema}"`)
        await pg.query(postgresStateTable)
        db = new PostgresStateDatabase(pg)
      }
      namespace = 'app:' + randomUUID()
      state = new ListenerState(db, namespace)
      journal = new ExecutionJournal(state)
      await journal.initialize()
      lease = (await state.acquire(randomUUID(), 300000))!
      key = await journal.define(lease, definition, 'personal')
    })
    afterEach(async () => {
      await sqlite?.close()
      sqlite = undefined
      if (directory) {
        rmSync(directory, { recursive: true, force: true })
        directory = undefined
      }
      if (pg?.isInitialized) {
        try {
          await pg.query(`DROP SCHEMA "${schema}" CASCADE`)
        } finally {
          await pg.destroy()
          pg = undefined
        }
      }
    })
    it('does not bind counted supply reservations to the triggering job', async () => {
      const capacity = testCapacity({ account: 2, tenant: 2 })
      const reserve = () => journal.reserve(lease, key, demand, capacity, { labels: ['boxlite'] })
      const first = await reserve()
      const second = await reserve()
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(second!.record.key).not.toBe(first!.record.key)
      expect(await journal.used(definition.organization)).toBe(2)
      expect(await reserve()).toBeUndefined()
    })
    const recordClaim = (installationId: number, repositoryId: number, runner: number) =>
      state.ingress(`${installationId}/${repositoryId}`, async (tx) => {
        await tx.write(
          await observeDemand(
            tx,
            { installationId, accountId: 7, repositoryId, job: { id: demand.job, runId: demand.run } },
            { status: 'in_progress', labels: ['boxlite'], runner },
          ),
        )
      })
    it('reads claims only from the original installation and requested runners', async () => {
      await recordClaim(1, 21, 91)
      await recordClaim(2, 21, 92)
      expect(await journal.claimedRunners(lease, definition, [91, 92, 93])).toEqual(new Set([91]))
      expect(await journal.claimedRunners(lease, definition, [])).toEqual(new Set())
      expect(await journal.claimedRunners(lease, definition, [93])).toEqual(new Set())
    })
    it('withholds runner claim certainty when running observations overlap', async () => {
      await recordClaim(1, 21, 91)
      await state.ingress('1/21', async (tx) =>
        tx.write(
          await observeDemand(
            tx,
            { installationId: 1, accountId: 7, repositoryId: 21, job: { id: 56, runId: 33 } },
            { status: 'in_progress', labels: ['boxlite'], runner: 91 },
          ),
        ),
      )
      expect(await journal.claimedRunners(lease, definition, [91])).toEqual(new Set())
    })
    it.each(['repository', 'organization'] as const)('rejects a claim outside the %s scope', async (kind) => {
      await recordClaim(1, 22, 91)
      const scope: ExecutionScope =
        kind === 'repository'
          ? definition
          : {
              ...definition,
              installation: { id: 1, account: { id: 7, login: 'owner', type: 'Organization' } },
              runners: {
                kind: 'organization',
                account: { id: 7, login: 'owner' },
                group: 5,
                repositories: [21],
                allowPrivate: true,
                allowPublic: false,
              },
            }
      await expect(journal.claimedRunners(lease, scope, [91])).rejects.toBeInstanceOf(StateCorrupt)
      if (scope.runners.kind === 'organization') {
        scope.runners.repositories.push(22)
        expect(await journal.claimedRunners(lease, scope, [91])).toEqual(new Set([91]))
      }
    })
    it.each([{ repository: 0 }, { run: null }, { job: '55' }, { status: 'queued' }, { ambiguous: 'true' }])(
      'rejects malformed persisted runner claims: %j',
      async (change) => {
        await recordClaim(1, 21, 91)
        const [row] = await state.read(['runner-claim/1/91'])
        await state.commit(lease, [
          {
            key: row.key,
            expected: row.version,
            payload: JSON.parse(JSON.stringify({ ...(row.payload as object), ...change })),
          },
        ])
        await expect(journal.claimedRunners(lease, definition, [91])).rejects.toBeInstanceOf(StateCorrupt)
      },
    )
    it.each([
      null,
      { labels: null },
      { labels: [] },
      { labels: [17] },
      { labels: ['linux'] },
      { labels: ['boxlite', 'linux', 'LINUX'] },
      { labels: ['boxlite-0vcpu-4gbmem-10gbdisk'] },
    ])('rejects malformed supply persisted on a real reservation: %j', async (supply) => {
      const row = (await journal.reserve(lease, key, demand, limits, { labels: ['boxlite'] }))!
      await state.commit(lease, [
        {
          key: row.record.key,
          expected: row.record.version,
          payload: JSON.parse(JSON.stringify({ ...row.value, supply })),
        },
      ])
      await expect(journal.allocation(lease, row.record.key)).rejects.toBeInstanceOf(StateCorrupt)
      expect(await journal.used(definition.organization)).toBe(1)
    })
    it('defines known and new scopes without enumerating retained history', async () => {
      for (let generation = 2; generation <= 6; generation++) await journal.define(lease, { ...definition, generation })
      const pages: string[] = []
      const observed: StateDatabase = {
        transaction: (namespace, work, mode) =>
          db.transaction(
            namespace,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (key, lock) => tx.get(key, lock),
                put: (record, expected) => tx.put(record, expected),
                remove: (key, expected) => tx.remove(key, expected),
                page: (after, limit, prefix) => {
                  pages.push(prefix ?? '')
                  return tx.page(after, limit, prefix)
                },
              }),
            mode,
          ),
      }
      const measured = new ExecutionJournal(new ListenerState(observed, namespace))
      expect(await measured.define(lease, definition)).toBe(key)
      await measured.define(lease, { ...definition, generation: 7 })
      expect(pages).toEqual([])
    })
    it('uses only point reads for worker, authorization, quota and allocation lifecycle regardless of history', async () => {
      await state.commit(lease, [{ key: 'backend/test', expected: null, payload: { app: 'personal' } }])
      const pages: string[] = []
      let reads = 0
      const observed: StateDatabase = {
        transaction: (namespace, work, mode) =>
          db.transaction(
            namespace,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (key, lock) => {
                  reads++
                  return tx.get(key, lock)
                },
                put: (record, expected) => tx.put(record, expected),
                remove: (key, expected) => tx.remove(key, expected),
                page: (after, limit, prefix) => {
                  pages.push(prefix ?? '')
                  return tx.page(after, limit, prefix)
                },
              }),
            mode,
          ),
      }
      const measuredState = new ListenerState(observed, namespace)
      const measured = new ExecutionJournal(measuredState)
      const apps = new ScopeApplications(measuredState, 'backend/test', 'personal')
      const exercise = async () => {
        reads = 0
        let row = (await measured.reserve(lease, key, demand, limits))!
        expect((await measured.allocation(lease, row.record.key))?.value.job).toEqual(demand)
        expect(await apps.application(lease, definition)).toBe('personal')
        expect(await measured.used(definition.organization)).toBe(1)
        expect(await measured.hasCapacity(lease, key, limits)).toBe(false)
        row = await measured.advance(lease, row.record.key, row.record.version, {
          box: { phase: 'absent', id: null },
          runner: { phase: 'absent', id: null },
        })
        await measured.release(lease, row.record.key, row.record.version)
        return reads
      }
      const before = await exercise()
      for (let generation = 2; generation <= 40; generation++)
        await journal.define(lease, { ...definition, generation })
      expect(await exercise()).toBe(before)
      expect(pages).toEqual([])
    })
    it('rolls back every reservation record when the final worker write fails', async () => {
      let injected = false
      const failing: StateDatabase = {
        transaction: (namespace, work, mode) =>
          db.transaction(
            namespace,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (key, lock) => tx.get(key, lock),
                page: (after, limit, prefix) => tx.page(after, limit, prefix),
                remove: (key, expected) => tx.remove(key, expected),
                put: (record, expected) => {
                  if (record.key.startsWith('worker/')) {
                    injected = true
                    throw Error('worker storage interrupted')
                  }
                  return tx.put(record, expected)
                },
              }),
            mode,
          ),
      }
      const before = await state.recover(lease)
      await expect(
        new ExecutionJournal(new ListenerState(failing, namespace)).reserve(lease, key, demand, limits),
      ).rejects.toThrow('worker storage interrupted')
      expect(injected).toBe(true)
      expect(await state.recover(lease)).toEqual(before)
      expect(await journal.reserve(lease, key, demand, limits)).toBeDefined()
    })
    it('keeps active membership when final release races a new reservation', async () => {
      let old = (await journal.reserve(lease, key, demand, limits))!
      old = await journal.advance(lease, old.record.key, old.record.version, {
        box: { phase: 'absent', id: null },
        runner: { phase: 'absent', id: null },
      })
      const attempts = await Promise.allSettled([
        journal.release(lease, old.record.key, old.record.version),
        journal.reserve(lease, key, { ...demand, job: 56 }, limits),
      ])
      for (const result of attempts)
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StateConflict)
      if (attempts[0].status === 'rejected') await journal.release(lease, old.record.key, old.record.version)
      if (attempts[1].status === 'rejected') await journal.reserve(lease, key, { ...demand, job: 56 }, limits)
      const active = await journal.activeScopes(lease)
      expect(active.rows).toHaveLength(1)
      expect(active.rows[0].active).toBe(1)
      expect((await journal.workers(lease, key)).rows.map((row) => row.value.job.job)).toEqual([56])
      expect(await journal.used(definition.organization)).toBe(1)
    })
    it('continues keyset recovery after a deleted cursor at an exact page boundary', async () => {
      const capacity = testCapacity({ account: 10, tenant: 10 })
      for (let job = 100; job < 104; job++) await journal.reserve(lease, key, { ...demand, job }, capacity)
      const first = await journal.workers(lease, key, '', 2)
      expect(first.rows).toHaveLength(2)
      expect(first.after).not.toBe('')
      let cursor = first.rows[1]
      cursor = await journal.advance(lease, cursor.record.key, cursor.record.version, {
        box: { phase: 'absent', id: null },
        runner: { phase: 'absent', id: null },
      })
      await journal.release(lease, cursor.record.key, cursor.record.version)
      const second = await journal.workers(lease, key, first.after, 2)
      expect(second.rows).toHaveLength(2)
      expect(new Set([...first.rows, ...second.rows].map((row) => row.record.key)).size).toBe(4)
      expect(await journal.workers(lease, key, second.after, 2)).toEqual({ rows: [], after: '' })
    })
    it('rejects a job deduplication record pointing at a different valid allocation', async () => {
      const row = (await journal.reserve(lease, key, demand, limits))!
      await state.commit(lease, [
        {
          key: 'job/' + definition.installation.id + '/' + demand.repository + '/999',
          expected: null,
          payload: { worker: row.record.key },
        },
      ])
      await expect(journal.reserve(lease, key, { ...demand, job: 999 }, limits)).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('keeps all capacity domains counted when the selected policy changes', async () => {
      await journal.reserve(lease, key, demand, { limits: [{ domain: 'organization', maximum: 5 }] })
      for (const domain of ['global', 'organization', 'account'] as const)
        expect(await journal.hasCapacity(lease, key, { limits: [{ domain, maximum: 1 }] })).toBe(false)
      const next = await journal.define(lease, { ...definition, generation: 2 })
      expect(await journal.reserve(lease, next, demand, testCapacity({ account: 5, tenant: 5 }))).toBeUndefined()
      expect(await journal.used(definition.organization)).toBe(1)
    })
    it('returns capacity exactly once and keeps domain records at zero after final release', async () => {
      let row = (await journal.reserve(lease, key, demand, limits))!
      row = await journal.advance(lease, row.record.key, row.record.version, { box: { phase: 'absent', id: null } })
      row = await journal.advance(lease, row.record.key, row.record.version, { box: { phase: 'absent', id: null } })
      expect(await journal.used(definition.organization)).toBe(0)
      expect(await journal.reserve(lease, key, demand, limits)).toBeUndefined()
      row = await journal.advance(lease, row.record.key, row.record.version, { runner: { phase: 'absent', id: null } })
      await journal.release(lease, row.record.key, row.record.version)
      expect((await state.scan(lease, { prefix: 'usage/' })).map((row) => row.payload)).toEqual([
        { used: 0 },
        { used: 0 },
        { used: 0 },
      ])
      expect(await state.scan(lease, { prefix: 'domain/' })).toHaveLength(3)
      expect(await state.scan(lease, { prefix: 'active-scope/' })).toEqual([])
      expect(await state.scan(lease, { prefix: 'active-worker/' })).toEqual([])
      expect(await state.scan(lease, { prefix: 'job/' })).toEqual([])
      expect(await journal.reserve(lease, key, demand, limits)).toBeDefined()
    })
    it.each(['domain/global', 'usage/global'])('does not recreate a missing established %s', async (missing) => {
      const [row] = await state.read([missing])
      await state.commit(lease, [{ key: row.key, expected: row.version }])
      await expect(journal.define(lease, definition)).rejects.toBeInstanceOf(StateCorrupt)
      await expect(journal.define(lease, { ...definition, generation: 2 })).rejects.toBeInstanceOf(StateCorrupt)
      await expect(journal.reserve(lease, key, demand, limits)).rejects.toBeInstanceOf(StateCorrupt)
      expect(await state.read([missing])).toEqual([])
    })
    it('rejects an existing namespace without the new format rather than backfilling it', async () => {
      const legacy = new ListenerState(db, namespace + '-legacy')
      await legacy.initialize([{ key: 'catalog/scopes', payload: { keys: [] } }])
      await expect(new ExecutionJournal(legacy).initialize()).rejects.toBeInstanceOf(StateCorrupt)
      expect(await legacy.read(['journal/format'])).toEqual([])
    })
    if (backend === 'sqlite')
      it('accepts more than 10000 retained scopes without deleting history', async () => {
        for (let generation = 2; generation <= 10002; generation++)
          await journal.define(lease, { ...definition, generation })
        expect((await journal.scope(lease, key)).scope).toEqual(definition)
        expect(await journal.define(lease, { ...definition, generation: 10003 })).toBeDefined()
        expect(await journal.activeScopes(lease)).toEqual({ rows: [], after: '' })
        expect(await state.read(['catalog/scopes'])).toEqual([])
      }, 60000)
    it('pins original App provenance at definition and rejects missing mappings', async () => {
      await state.commit(lease, [{ key: 'backend/test', expected: null, payload: { app: 'personal' } }])
      const apps = new ScopeApplications(state, 'backend/test', 'personal')
      expect(await apps.application(lease, definition)).toBe('personal')
      const other = { ...definition, binding: 'org-binding' }
      const otherKey = await apps.define(lease, other, 'organization')
      expect(await apps.application(lease, other)).toBe('organization')
      await expect(apps.define(lease, other, 'personal')).rejects.toBeInstanceOf(StateCorrupt)
      const [mapping] = await state.read(['app-scope/' + otherKey.slice(6)])
      await state.commit(lease, [{ key: mapping.key, expected: mapping.version }])
      expect(await state.read([mapping.key])).toEqual([])
      await expect(apps.application(lease, other)).rejects.toBeInstanceOf(StateCorrupt)
      await expect(apps.define(lease, other, 'organization')).rejects.toBeInstanceOf(StateCorrupt)
      expect(await apps.application(lease, definition)).toBe('personal')
    })
    it('rolls back the scope and index when storing its App association fails', async () => {
      await state.commit(lease, [{ key: 'backend/test', expected: null, payload: { app: 'personal' } }])
      await new ScopeApplications(state, 'backend/test', 'personal').initialize(lease)
      let blocked = false
      const failing: StateDatabase = {
        transaction: (namespace, work, mode) =>
          db.transaction(
            namespace,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (key, lock) => tx.get(key, lock),
                page: (after, limit, prefix) => tx.page(after, limit, prefix),
                remove: (key, expected) => tx.remove(key, expected),
                put: async (record, expected) => {
                  if (record.key.startsWith('app-scope/')) {
                    blocked = true
                    throw Error('association storage interrupted')
                  }
                  return tx.put(record, expected)
                },
              }),
            mode,
          ),
      }
      const broken = new ScopeApplications(new ListenerState(failing, namespace), 'backend/test', 'personal')
      const candidate = { ...definition, binding: 'new-app-scope' }
      const before = (await inspectJournal(state, lease)).usage
      await expect(broken.define(lease, candidate, 'organization')).rejects.toThrow('association storage interrupted')
      expect(blocked).toBe(true)
      expect((await inspectJournal(state, lease)).usage).toEqual(before)
      expect((await inspectJournal(state, lease)).scopes.size).toBe(1)
      expect(await state.scan(lease, { prefix: 'app-scope/' })).toHaveLength(1)
      await new ScopeApplications(state, 'backend/test', 'personal').define(lease, candidate, 'organization')
      expect((await inspectJournal(state, lease)).scopes.size).toBe(2)
    })
    it('captures a scope and lease before asynchronous App association initialization', async () => {
      await state.commit(lease, [{ key: 'backend/test', expected: null, payload: { app: 'personal' } }])
      const apps = new ScopeApplications(state, 'backend/test', 'personal')
      const external = { ...lease },
        candidate = structuredClone(definition)
      candidate.binding = 'captured'
      const pending = apps.define(external, candidate, 'organization')
      external.epoch++
      candidate.binding = 'changed'
      await pending
      expect(await apps.application(lease, { ...definition, binding: 'captured' })).toBe('organization')
      await expect(apps.application(lease, candidate)).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('reserves a single tenant budget across two Apps with atomic scope associations', async () => {
      await state.commit(lease, [{ key: 'backend/test', expected: null, payload: { app: 'personal' } }])
      const apps = new ScopeApplications(state, 'backend/test', 'personal')
      await apps.initialize(lease)
      const other = { ...definition, binding: 'other-app-binding' }
      const otherKey = await apps.define(lease, other, 'organization')
      const attempts = await Promise.allSettled([
        journal.reserve(lease, key, demand, limits),
        journal.reserve(lease, otherKey, { ...demand, job: 56 }, limits),
      ])
      expect(attempts.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(1)
      expect((await inspectJournal(state, lease)).allocations.size).toBe(1)
      expect(await apps.application(lease, other)).toBe('organization')
    })
    it('hosted quota zero pauses new admission without an allocation intent', async () => {
      expect(await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 0 }))).toBeUndefined()
      expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    })
    it('hosted quota null preserves an unlimited Commerce resolution', async () => {
      const first = await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: null }))
      const second = await journal.reserve(
        lease,
        key,
        { ...demand, job: 56 },
        testCapacity({ account: null, tenant: null }),
      )
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(
        (await inspectJournal(state, lease)).workers.filter((worker) => worker.organization === definition.organization)
          .length,
      ).toBe(2)
    })
    it('hosted quota aggregates different GitHub installations under one BoxLite account', async () => {
      await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 1 }))
      const other = structuredClone(definition)
      other.binding = 'binding-b'
      other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
      other.runners = {
        kind: 'repository',
        allowPrivate: true,
        allowPublic: false,
        repository: { id: 22, name: 'other-repo', private: true, owner: { id: 8, login: 'other' } },
      }
      const otherKey = await journal.define(lease, other)
      expect(
        await journal.reserve(
          lease,
          otherKey,
          { ...demand, repository: 22, job: 56 },
          testCapacity({ account: null, tenant: 1 }),
        ),
      ).toBeUndefined()
      expect(
        (await inspectJournal(state, lease)).workers.filter((worker) => worker.organization === definition.organization)
          .length,
      ).toBe(1)
    })
    it('hosted quota applies the settings version fence to the reservation transaction', async () => {
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant-a', expected: null, payload: { maximum: 2 } }])
      const usage = (await inspectJournal(state, lease)).usage
      await state.commit(lease, [{ key: policy.key, expected: policy.version, payload: { maximum: 0 } }])
      await expect(
        journal.reserve(
          lease,
          key,
          demand,
          testCapacity({
            account: null,
            tenant: 2,
            checks: [{ key: policy.key, version: policy.version }],
          }),
        ),
      ).rejects.toBeInstanceOf(StateConflict)
      const snapshot = await inspectJournal(state, lease)
      expect(snapshot.allocations.size).toBe(0)
      expect(snapshot.usage).toEqual(usage)
    })
    it('hosted quota captures nested settings checks before loading the journal', async () => {
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant-a', expected: null, payload: { maximum: 2 } }])
      const checks: { key: string; version: string }[] = [{ key: policy.key, version: randomUUID() }]
      const pending = journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 2, checks }))
      checks[0].version = policy.version
      await expect(pending).rejects.toBeInstanceOf(StateConflict)
      expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    })
    it('hosted quota accepts finite Commerce limits above the former static ceiling', async () => {
      expect(await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 1001 }))).toBeDefined()
    })
    it('hosted quota rejects negative, nonfinite and unsafe limits', async () => {
      for (const tenant of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        await expect(journal.reserve(lease, key, demand, testCapacity({ account: null, tenant }))).rejects.toThrow()
      expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    })
    it('enforces global and organization limits using original allocation domains', async () => {
      const shared = { maximum: 3, domain: 'global' as const }
      const isolated = {
        maximum: 1,
        domain: 'organization' as const,
      }
      const policy = { limits: [shared, isolated] }
      await journal.reserve(lease, key, demand, policy)
      expect(await journal.reserve(lease, key, { ...demand, job: 56 }, policy)).toBeUndefined()
      const other = structuredClone(definition)
      other.binding = 'independent-policy-group'
      other.organization = 'independent-organization'
      if (other.runners.kind !== 'repository') throw Error('Repository fixture required')
      other.runners.repository.id = 22
      const next = await journal.define(lease, other)
      expect(await journal.reserve(lease, next, { ...demand, repository: 22, job: 57 }, policy)).toBeDefined()
      expect((await inspectJournal(state, lease)).workers).toHaveLength(2)
    })
    it('captures each rule maximum before the asynchronous journal read', async () => {
      const rule = { maximum: 0, domain: 'global' as const }
      const pending = journal.reserve(lease, key, demand, { limits: [rule] })
      rule.maximum = 100
      expect(await pending).toBeUndefined()
      expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    })
    it('rejects absent, invalid or inapplicable rules without persisting an allocation', async () => {
      for (const policy of [
        { limits: [] },
        { limits: [{ maximum: 1, domain: 'unknown' as any }] },
        { limits: [{ maximum: 1, domain: null as any }] },
        { limits: Array.from({ length: 101 }, () => ({ maximum: 1, domain: 'global' as const })) },
      ])
        await expect(journal.reserve(lease, key, demand, policy)).rejects.toThrow()
      expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    })
    it('persists canonical original scope metadata and strips unrelated secret-shaped fields', async () => {
      const extra = { ...structuredClone(definition), privateToken: 'test-only-sensitive-extra' }
      expect(await journal.define(lease, extra)).toBe(key)
      const rows = await inspectJournal(state, lease)
      expect(rows.scopes.get(key)!.scope).toEqual(definition)
      expect(JSON.stringify(await state.recover(lease))).not.toContain('test-only-sensitive-extra')
    })
    it('counts an earlier binding generation against the original account quota', async () => {
      const first = await journal.reserve(lease, key, demand, limits)
      expect(first).toBeDefined()
      const next = await journal.define(lease, {
        ...definition,
        generation: 2,
        organization: 'tenant-b',
        actor: 'owner-b',
      })
      expect(await journal.reserve(lease, next, { ...demand, job: 56 }, limits)).toBeUndefined()
      const snapshot = await inspectJournal(state, lease)
      expect(snapshot.scopes.get(key)!.scope.actor).toBe('owner-a')
      expect(snapshot.allocations.get(first!.record.key)!.value.scope).toBe(key)
    })
    it('serializes cross-scope account quota reservations even with the same lease owner', async () => {
      const other = structuredClone(definition)
      if (other.runners.kind !== 'repository') throw new Error('fixture')
      other.runners.repository.id = 22
      other.runners.repository.name = 'repo-b'
      const second = await journal.define(lease, other)
      const results = await Promise.allSettled([
        journal.reserve(lease, key, demand, limits),
        journal.reserve(lease, second, { ...demand, repository: 22, job: 56 }, limits),
      ])
      for (const result of results)
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StateConflict)
      const snapshot = await inspectJournal(state, lease)
      expect(snapshot.allocations.size).toBe(1)
      expect([...snapshot.scopes.values()].reduce((sum, row) => sum + row.active.length, 0)).toBe(1)
    })
    it('enforces tenant quota across different GitHub accounts', async () => {
      await journal.reserve(lease, key, demand, testCapacity({ account: 2, tenant: 1 }))
      const other = structuredClone(definition)
      other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
      if (other.runners.kind !== 'repository') throw new Error('fixture')
      other.runners.repository = { ...other.runners.repository, id: 22, owner: { id: 8, login: 'other' } }
      const second = await journal.define(lease, other)
      expect(
        await journal.reserve(
          lease,
          second,
          { ...demand, repository: 22, job: 56 },
          testCapacity({ account: 2, tenant: 1 }),
        ),
      ).toBeUndefined()
    })
    it('preserves an opaque provider subject rather than requiring an identifier format', async () => {
      const actor = 'provider|Case-Sensitive-Account',
        target = await journal.define(lease, { ...definition, actor })
      expect((await inspectJournal(state, lease)).scopes.get(target)?.scope.actor).toBe(actor)
    })
    it('does not settle or reset an unknown create intent', async () => {
      const reserved = (await journal.reserve(lease, key, demand, limits))!
      const pending = await journal.advance(lease, reserved.record.key, reserved.record.version, {
        box: { phase: 'requested', id: null },
        effect: { id: randomUUID(), kind: 'box-create' },
      })
      await expect(journal.release(lease, pending.record.key, pending.record.version)).rejects.toThrow(
        'confirmed cleanup',
      )
      await expect(
        journal.advance(lease, pending.record.key, pending.record.version, { box: { phase: 'absent', id: null } }),
      ).rejects.toThrow('replayed')
      expect(await journal.reserve(lease, key, { ...demand, job: 56 }, limits)).toBeUndefined()
    })
    const registeredAllocation = async () => {
      let row = (await journal.reserve(lease, key, demand, limits))!
      row = await journal.advance(lease, row.record.key, row.record.version, {
        box: { phase: 'requested', id: null },
        effect: { id: randomUUID(), kind: 'box-create' },
      })
      row = await journal.advance(lease, row.record.key, row.record.version, { box: { phase: 'known', id: 'box' } })
      row = await journal.advance(lease, row.record.key, row.record.version, {
        runner: { phase: 'requested', id: null },
        effect: { id: randomUUID(), kind: 'runner-register' },
      })
      return journal.advance(lease, row.record.key, row.record.version, { runner: { phase: 'known', id: 91 } })
    }
    it.each([0, Number.MAX_SAFE_INTEGER])(
      'preserves a persisted runner registration timestamp: %s',
      async (registeredAt) => {
        const row = await registeredAllocation()
        await state.commit(lease, [
          {
            key: row.record.key,
            expected: row.record.version,
            payload: JSON.parse(JSON.stringify({ ...row.value, runner: { ...row.value.runner, registeredAt } })),
          },
        ])
        expect((await journal.allocation(lease, row.record.key))?.value.runner).toMatchObject({ registeredAt })
        expect(await journal.used(definition.organization)).toBe(1)
      },
    )
    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
      'rejects an invalid persisted runner registration timestamp: %s',
      async (registeredAt) => {
        const row = await registeredAllocation()
        await state.commit(lease, [
          {
            key: row.record.key,
            expected: row.record.version,
            payload: JSON.parse(JSON.stringify({ ...row.value, runner: { ...row.value.runner, registeredAt } })),
          },
        ])
        await expect(journal.allocation(lease, row.record.key)).rejects.toBeInstanceOf(StateCorrupt)
        expect(await journal.used(definition.organization)).toBe(1)
      },
    )
    it('recovery regression: returns physical quota after confirmed Box absence while retaining runner debt and job dedup', async () => {
      let row = (await journal.reserve(lease, key, demand, limits))!
      const change = async (value: Parameters<ExecutionJournal['advance']>[3]) => {
        row = await journal.advance(lease, row.record.key, row.record.version, value)
      }
      await change({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
      await change({ box: { phase: 'known', id: 'original-box' } })
      await change({ runner: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'runner-register' } })
      await change({ runner: { phase: 'known', id: 91 } })
      await change({ box: { phase: 'absent', id: 'original-box' }, closing: true })
      const recovered = await inspectJournal(state, lease)
      expect(recovered.workers.filter((worker) => worker.installation.account.id === 7).length).toBe(0)
      expect(recovered.workers.filter((worker) => worker.organization === 'tenant-a').length).toBe(0)
      expect(recovered.allocations.get(row.record.key)?.value.runner).toEqual({ phase: 'known', id: 91 })
      await expect(journal.release(lease, row.record.key, row.record.version)).rejects.toThrow('confirmed cleanup')
      expect(await journal.reserve(lease, key, demand, limits)).toBeUndefined()
      expect(await journal.reserve(lease, key, { ...demand, job: 56 }, limits)).toBeDefined()
    })
    it('preserves known resource IDs and releases only confirmed original resources', async () => {
      let row = (await journal.reserve(lease, key, demand, limits))!
      row = await journal.advance(lease, row.record.key, row.record.version, {
        box: { phase: 'requested', id: null },
        effect: { id: randomUUID(), kind: 'box-create' },
      })
      row = await journal.advance(lease, row.record.key, row.record.version, {
        box: { phase: 'known', id: 'box-original' },
      })
      await expect(
        journal.advance(lease, row.record.key, row.record.version, { box: { phase: 'known', id: 'box-foreign' } }),
      ).rejects.toThrow('cannot change')
      row = await journal.advance(lease, row.record.key, row.record.version, {
        box: { phase: 'absent', id: 'box-original' },
        runner: { phase: 'absent', id: null },
        closing: true,
      })
      await journal.release(lease, row.record.key, row.record.version)
      const recovered = await inspectJournal(state, lease)
      expect(recovered.scopes.get(key)!.active).toEqual([])
      expect(recovered.allocations.size).toBe(0)
      expect(await journal.reserve(lease, key, { ...demand, job: 56 }, limits)).toBeDefined()
    })
    it('rejects active resource metadata without its durable operation identity', async () => {
      const reserved = (await journal.reserve(lease, key, demand, limits))!
      await expect(
        journal.advance(lease, reserved.record.key, reserved.record.version, { box: { phase: 'requested', id: null } }),
      ).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('does not heal a missing journal format marker during restart', async () => {
      const [index] = await state.read(['journal/format'])
      await state.commit(lease, [{ key: index.key, expected: index.version }])
      await expect(journal.initialize()).rejects.toBeInstanceOf(StateCorrupt)
      await expect(journal.check(lease)).rejects.toBeInstanceOf(StateCorrupt)
    })
  })
}
