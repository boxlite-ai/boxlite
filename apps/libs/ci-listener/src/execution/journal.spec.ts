/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
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
import { ExecutionScope } from './model'

const definition: ExecutionScope = {
  binding: 'binding-a',
  generation: 1,
  organization: 'tenant-a',
  actor: 'owner-a',
  installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
  runners: {
    kind: 'repository',
    repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
    allowPublic: false,
  },
}
const demand = { repository: 21, run: 33, job: 55 },
  limits = testCapacity({ account: 1, tenant: 1 })
const url = process.env.CI_CONNECT_TEST_DATABASE_URL
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !url ? describe.skip : describe
  suite(`CI shared execution journal ${backend}`, () => {
    let db: StateDatabase,
      sqlite: SqliteStateDatabase | undefined,
      pg: DataSource | undefined,
      state: ListenerState,
      journal: ExecutionJournal,
      lease: ExecutionLease,
      key: string,
      directory: string | undefined,
      schema: string
    beforeEach(async () => {
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-journal-'))
        sqlite = new SqliteStateDatabase(directory)
        db = sqlite
      } else {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
          throw new Error('Disposable local PostgreSQL required')
        schema = 'ci_journal_' + randomUUID().replaceAll('-', '')
        pg = await new DataSource({
          type: 'postgres',
          url,
          extra: { options: `-c search_path=${schema},public` },
        }).initialize()
        await pg.query(`CREATE SCHEMA "${schema}"`)
        await pg.query(postgresStateTable)
        db = new PostgresStateDatabase(pg)
      }
      state = new ListenerState(db, 'app:' + randomUUID())
      journal = new ExecutionJournal(state)
      await journal.initialize()
      lease = (await state.acquire(randomUUID(), 300000))!
      key = await journal.define(lease, definition)
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
    it('hosted quota zero pauses new admission without an allocation intent', async () => {
      expect(await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 0 }))).toBeUndefined()
      expect((await journal.load(lease)).allocations.size).toBe(0)
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
        (await journal.load(lease)).workers.filter((worker) => worker.organization === definition.organization).length,
      ).toBe(2)
    })
    it('hosted quota aggregates different GitHub installations under one BoxLite account', async () => {
      await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 1 }))
      const other = structuredClone(definition)
      other.binding = 'binding-b'
      other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
      other.runners = {
        kind: 'repository',
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
        (await journal.load(lease)).workers.filter((worker) => worker.organization === definition.organization).length,
      ).toBe(1)
    })
    it('hosted quota applies the settings version fence to the reservation transaction', async () => {
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant-a', expected: null, payload: { maximum: 2 } }])
      const index = (await journal.load(lease)).index
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
      const snapshot = await journal.load(lease)
      expect(snapshot.allocations.size).toBe(0)
      expect(snapshot.index).toEqual(index)
    })
    it('hosted quota captures nested settings checks before loading the journal', async () => {
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant-a', expected: null, payload: { maximum: 2 } }])
      const checks: { key: string; version: string }[] = [{ key: policy.key, version: randomUUID() }]
      const pending = journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 2, checks }))
      checks[0].version = policy.version
      await expect(pending).rejects.toBeInstanceOf(StateConflict)
      expect((await journal.load(lease)).allocations.size).toBe(0)
    })
    it('hosted quota accepts finite Commerce limits above the former static ceiling', async () => {
      expect(await journal.reserve(lease, key, demand, testCapacity({ account: null, tenant: 1001 }))).toBeDefined()
    })
    it('hosted quota rejects negative, nonfinite and unsafe limits', async () => {
      for (const tenant of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        await expect(journal.reserve(lease, key, demand, testCapacity({ account: null, tenant }))).rejects.toThrow()
      expect((await journal.load(lease)).allocations.size).toBe(0)
    })
    it('enforces all supplied membership rules without recognizing their policy dimensions', async () => {
      const shared = { maximum: 3, includes: () => true }
      const isolated = {
        maximum: 1,
        includes: (worker: ExecutionScope, candidate: ExecutionScope) => worker.binding === candidate.binding,
      }
      const policy = { limits: [shared, isolated] }
      await journal.reserve(lease, key, demand, policy)
      expect(await journal.reserve(lease, key, { ...demand, job: 56 }, policy)).toBeUndefined()
      const other = structuredClone(definition)
      other.binding = 'independent-policy-group'
      if (other.runners.kind !== 'repository') throw Error('Repository fixture required')
      other.runners.repository.id = 22
      const next = await journal.define(lease, other)
      expect(await journal.reserve(lease, next, { ...demand, repository: 22, job: 57 }, policy)).toBeDefined()
      expect((await journal.load(lease)).workers).toHaveLength(2)
    })
    it('captures each rule maximum before the asynchronous journal read', async () => {
      const rule = { maximum: 0, includes: () => true }
      const pending = journal.reserve(lease, key, demand, { limits: [rule] })
      rule.maximum = 100
      expect(await pending).toBeUndefined()
      expect((await journal.load(lease)).allocations.size).toBe(0)
    })
    it('rejects absent, invalid or inapplicable rules without persisting an allocation', async () => {
      for (const policy of [
        { limits: [] },
        { limits: [{ maximum: 1, includes: () => false }] },
        { limits: [{ maximum: 1, includes: null as any }] },
        { limits: Array.from({ length: 101 }, () => ({ maximum: 1, includes: () => true })) },
      ])
        await expect(journal.reserve(lease, key, demand, policy)).rejects.toThrow()
      expect((await journal.load(lease)).allocations.size).toBe(0)
    })
    it('persists canonical original scope metadata and strips unrelated secret-shaped fields', async () => {
      const extra = { ...structuredClone(definition), privateToken: 'test-only-sensitive-extra' }
      expect(await journal.define(lease, extra)).toBe(key)
      const rows = await journal.load(lease)
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
      const snapshot = await journal.load(lease)
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
      const snapshot = await journal.load(lease)
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
      expect((await journal.load(lease)).scopes.get(target)?.scope.actor).toBe(actor)
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
      const recovered = await new ExecutionJournal(state).load(lease)
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
      const recovered = await journal.load(lease)
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
    it('does not heal a missing permanent business index during restart', async () => {
      const [index] = await state.read(['catalog/scopes'])
      await state.commit(lease, [{ key: index.key, expected: index.version }])
      await expect(journal.initialize()).rejects.toBeInstanceOf(StateCorrupt)
      await expect(journal.load(lease)).rejects.toBeInstanceOf(StateCorrupt)
    })
  })
}
