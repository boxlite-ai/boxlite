/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { Json, StateDatabase, StateConflict, StateCorrupt, LeaseLost } from './database'
import { ExecutionLease, ListenerState } from './store'
import { PostgresStateDatabase, postgresStateTable } from './postgres'
import { SqliteStateDatabase } from './sqlite'

for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.DB_HOST ? describe.skip : describe
  suite(`CI shared state ${backend}`, () => {
    let database: StateDatabase, state: ListenerState, namespace: string
    let local: SqliteStateDatabase | undefined, pg: DataSource | undefined
    let directory: string, schema: string
    beforeEach(async () => {
      namespace = 'app:' + randomUUID()
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-state-'))
        local = new SqliteStateDatabase(directory)
        database = local
      } else {
        if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
          throw new Error(`Disposable local PostgreSQL required: DB_HOST=${process.env.DB_HOST}`)
        schema = 'ci_core_' + randomUUID().replaceAll('-', '')
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
        database = new PostgresStateDatabase(pg)
      }
      state = new ListenerState(database, namespace)
      await state.initialize()
    })
    afterEach(async () => {
      await local?.close()
      local = undefined
      if (directory) rmSync(directory, { recursive: true, force: true })
      if (pg?.isInitialized) {
        try {
          await pg.query(`DROP SCHEMA "${schema}" CASCADE`)
        } finally {
          await pg.destroy()
          pg = undefined
        }
      }
    })
    const owner = async (): Promise<ExecutionLease> => (await state.acquire(randomUUID(), 10_000))!
    const roots = () =>
      database.transaction(namespace, async (tx) => ({
        owner: await tx.get('@owner'),
        lease: await tx.get('@lease'),
      }))
    async function legacy(until: number) {
      await database.transaction(namespace, async (tx) => {
        const current = (await tx.get('@owner', true))!
        const expiry = await tx.get('@lease')
        if (expiry) await tx.remove(expiry.key, expiry.version)
        await tx.put(
          { ...current, schema: 1, version: randomUUID(), payload: { ...(current.payload as object), until } },
          current.version,
        )
      })
    }
    it('renews only expiry while preserving the scheduler identity record', async () => {
      const lease = await owner(),
        before = await roots()
      await state.renew(lease, 20000)
      const after = await roots()
      expect(after.owner).toEqual(before.owner)
      expect(after.owner?.schema).toBe(2)
      expect(after.owner?.payload).toEqual({ owner: lease.owner, epoch: lease.epoch })
      expect(after.lease?.version).not.toBe(before.lease?.version)
      expect((after.lease?.payload as { until: number }).until).toBeGreaterThan(
        (before.lease?.payload as { until: number }).until,
      )
    })
    it('never shortens expiry when renewal requests a shorter duration', async () => {
      const lease = await owner(),
        before = await roots()
      await state.renew(lease, 100)
      expect((await roots()).lease?.payload).toEqual(before.lease?.payload)
      expect(await state.acquire('contender', 10000)).toBeUndefined()
    })
    it.each([0, 30000])(
      'upgrades a legacy deadline with %i ms remaining without changing identity or journal',
      async (remaining) => {
        const lease = await owner()
        const notice = await state.ingest([{ key: 'notice/upgrade', expected: null, payload: { job: 7 } }])
        const until = remaining ? Date.now() + remaining : 0
        await legacy(until)
        await state.initialize()
        const upgraded = await roots()
        expect(upgraded.owner).toMatchObject({ schema: 2, payload: { owner: lease.owner, epoch: lease.epoch } })
        expect(upgraded.owner?.payload).not.toHaveProperty('until')
        expect(upgraded.lease).toMatchObject({ schema: 1, payload: { until } })
        expect(await state.read(['notice/upgrade'])).toEqual(notice)
        await state.initialize()
        expect(await roots()).toEqual(upgraded)
        if (remaining) {
          expect(await state.acquire('successor', 10000)).toBeUndefined()
          await expect(state.renew(lease, 30000)).resolves.toBeUndefined()
        } else {
          expect(await state.acquire('successor', 10000)).toMatchObject({ epoch: lease.epoch + 1 })
          await expect(state.renew(lease, 10000)).rejects.toBeInstanceOf(LeaseLost)
        }
      },
    )
    it('rolls back the new expiry record when legacy identity upgrade fails', async () => {
      await owner()
      await legacy(Date.now() + 30000)
      const before = await roots(),
        failure = new Error('identity write interrupted')
      const failing: StateDatabase = {
        transaction: (ns, work, mode) =>
          database.transaction(
            ns,
            async (tx) => {
              const wrapped = Object.create(tx) as typeof tx
              wrapped.put = async (row, expected) => {
                if (row.key === '@owner') throw failure
                return tx.put(row, expected)
              }
              return work(wrapped)
            },
            mode,
          ),
      }
      await expect(new ListenerState(failing, namespace).initialize()).rejects.toBe(failure)
      expect(await roots()).toEqual(before)
      await expect(state.initialize()).resolves.toBeUndefined()
    })
    it.each([
      ['bootstrap', '@owner'],
      ['bootstrap', '@lease'],
      ['upgrade', '@lease'],
      ['upgrade', '@owner'],
      ['acquire', '@lease'],
      ['renew', '@lease'],
    ] as const)('rolls back %s when the conditional %s write loses its version', async (operation, key) => {
      const target = operation === 'bootstrap' ? namespace + ':fresh' : namespace
      const lease = operation === 'renew' || operation === 'upgrade' ? await owner() : undefined
      if (operation === 'upgrade') {
        await state.ingest([{ key: 'notice/upgrade-conflict', expected: null, payload: { job: 7 } }])
        await legacy(Date.now() + 30000)
      }
      const snapshot = () => database.transaction(target, (tx) => tx.page('', 100))
      const before = await snapshot()
      const conflicting: StateDatabase = {
        transaction: (ns, work, mode) =>
          database.transaction(
            ns,
            (tx) => {
              const wrapped = Object.create(tx) as typeof tx
              // Exercise a real conditional-write miss in each storage adapter.
              wrapped.put = (row, expected) => tx.put(row, row.key === key ? randomUUID() : expected)
              return work(wrapped)
            },
            mode,
          ),
      }
      const attempt = (storage: StateDatabase) => {
        const candidate = new ListenerState(storage, target)
        if (operation === 'acquire') return candidate.acquire('successor', 10000)
        if (operation === 'renew') return candidate.renew(lease!, 20000)
        return candidate.initialize()
      }
      await expect(attempt(conflicting)).rejects.toBeInstanceOf(StateConflict)
      expect(await snapshot()).toEqual(before)
      await attempt(database)
    })
    it.each<Json>([
      null,
      { owner: null, epoch: 0 },
      { owner: 'scheduler', epoch: '0' },
      { owner: 'scheduler', epoch: -1 },
    ])('rejects malformed scheduler identity %j without changing state', async (payload) => {
      await database.transaction(namespace, async (tx) => {
        const row = (await tx.get('@owner'))!
        await tx.put({ ...row, version: randomUUID(), payload }, row.version)
      })
      const before = await roots()
      await expect(state.initialize()).rejects.toBeInstanceOf(StateCorrupt)
      expect(await roots()).toEqual(before)
    })
    it.each<Json>([{ until: null }, {}, { until: 0.5 }])(
      'rejects malformed expiry %j at the ingress boundary',
      async (payload) => {
        await database.transaction(namespace, async (tx) => {
          const row = (await tx.get('@lease'))!
          await tx.put({ ...row, version: randomUUID(), payload }, row.version)
        })
        const before = await roots()
        await expect(
          state.ingest([{ key: 'notice/invalid-expiry', expected: null, payload: {} }]),
        ).rejects.toBeInstanceOf(StateCorrupt)
        expect(await roots()).toEqual(before)
        expect(await database.transaction(namespace, (tx) => tx.get('notice/invalid-expiry'))).toBeUndefined()
      },
    )
    it.each(['missing', 'invalid', 'mixed'])('rejects %s lease metadata without repairing it', async (kind) => {
      await owner()
      if (kind === 'mixed') await legacy(Date.now() + 30000)
      await database.transaction(namespace, async (tx) => {
        const row = await tx.get('@lease')
        if (kind === 'missing') await tx.remove(row!.key, row!.version)
        else if (kind === 'invalid')
          await tx.put({ ...row!, version: randomUUID(), payload: { until: -1 } }, row!.version)
        else await tx.put({ key: '@lease', schema: 1, version: randomUUID(), payload: { until: 0 } }, null)
      })
      const before = await roots()
      await expect(state.initialize()).rejects.toBeInstanceOf(StateCorrupt)
      expect(await roots()).toEqual(before)
    })
    it('rejects an invalid legacy deadline without partially upgrading', async () => {
      await legacy(-1)
      const before = await roots()
      await expect(state.initialize()).rejects.toBeInstanceOf(StateCorrupt)
      expect(await roots()).toEqual(before)
    })
    it('rejects old renewal while concurrent contenders acquire an expired lease', async () => {
      const previous = await owner()
      await database.transaction(namespace, async (tx) => {
        const row = (await tx.get('@lease'))!
        await tx.put({ ...row, version: randomUUID(), payload: { until: 0 } }, row.version)
      })
      const [renewed, ...contenders] = await Promise.allSettled([
        state.renew(previous, 10000),
        state.acquire('next-a', 10000),
        state.acquire('next-b', 10000),
      ])
      expect(renewed).toMatchObject({ status: 'rejected', reason: expect.any(LeaseLost) })
      expect(contenders.every((result) => result.status === 'fulfilled')).toBe(true)
      const winners = contenders.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      )
      expect(winners).toHaveLength(1)
      expect(winners[0]).toMatchObject({ epoch: previous.epoch + 1 })
      await expect(
        state.commit(previous, [{ key: 'worker/stale', expected: null, payload: {} }]),
      ).rejects.toBeInstanceOf(LeaseLost)
    })
    it('quota fence permits a matching version without modifying the policy', async () => {
      const lease = await owner()
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant', expected: null, payload: { limit: 2 } }])
      await state.commit(
        lease,
        [{ key: 'worker/guarded', expected: null, payload: { admitted: true } }],
        [{ key: policy.key, version: policy.version }],
      )
      expect(await state.read([policy.key])).toEqual([policy])
      expect((await state.read(['worker/guarded']))[0].payload).toEqual({ admitted: true })
    })
    it('quota fence rejects a stale policy before any allocation write', async () => {
      const lease = await owner()
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant', expected: null, payload: { limit: 2 } }])
      await state.commit(lease, [{ key: policy.key, expected: policy.version, payload: { limit: 0 } }])
      await expect(
        state.commit(
          lease,
          [{ key: 'worker/stale-policy', expected: null, payload: {} }],
          [{ key: policy.key, version: policy.version }],
        ),
      ).rejects.toBeInstanceOf(StateConflict)
      expect(await state.read(['worker/stale-policy'])).toEqual([])
    })
    it('quota fence rejects a missing permanent policy instead of admitting', async () => {
      const lease = await owner()
      await expect(
        state.commit(
          lease,
          [{ key: 'worker/missing-policy', expected: null, payload: {} }],
          [{ key: 'quota/missing', version: randomUUID() }],
        ),
      ).rejects.toBeInstanceOf(StateCorrupt)
      expect(await state.read(['worker/missing-policy'])).toEqual([])
    })
    it('quota fence captures caller checks before awaiting storage', async () => {
      const lease = await owner()
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant', expected: null, payload: { limit: 2 } }])
      const checks: { key: string; version: string }[] = [{ key: policy.key, version: randomUUID() }]
      const pending = state.commit(lease, [{ key: 'worker/mutable-check', expected: null, payload: {} }], checks)
      checks[0].version = policy.version
      await expect(pending).rejects.toBeInstanceOf(StateConflict)
      expect(await state.read(['worker/mutable-check'])).toEqual([])
    })
    it('quota fence rejects malformed or duplicate checks', async () => {
      const lease = await owner()
      const [policy] = await state.commit(lease, [{ key: 'quota/tenant', expected: null, payload: { limit: 2 } }])
      for (const checks of [
        [{ key: '@owner', version: policy.version }],
        [{ key: policy.key, version: 'invalid' }],
        [policy, policy].map((row) => ({ key: row.key, version: row.version })),
      ])
        await expect(
          state.commit(lease, [{ key: 'worker/invalid-check', expected: null, payload: {} }], checks),
        ).rejects.toThrow()
      expect(await state.read(['worker/invalid-check'])).toEqual([])
    })
    it('initializes idempotently and admits exactly one concurrent owner', async () => {
      await state.initialize()
      const leases = await Promise.all(Array.from({ length: 4 }, () => state.acquire(randomUUID(), 10_000)))
      expect(leases.filter(Boolean)).toHaveLength(1)
      await expect(state.renew(leases.find(Boolean)!, 10_000)).resolves.toBeUndefined()
    })
    it.each(['commit', 'renew', 'recover'] as const)(
      'captures original lease identity for %s before awaiting storage',
      async (operation) => {
        const current = await owner(),
          mutable = { ...current, owner: 'not-the-owner' }
        const pending =
          operation === 'commit'
            ? state.commit(mutable, [{ key: 'worker/not-authorized', expected: null, payload: {} }])
            : operation === 'renew'
              ? state.renew(mutable, 10000)
              : state.recover(mutable)
        Object.assign(mutable, current)
        await expect(pending).rejects.toBeInstanceOf(LeaseLost)
        expect(await state.read(['worker/not-authorized'])).toEqual([])
      },
    )
    it('captures original read keys before awaiting storage', async () => {
      await state.ingest([{ key: 'notice/captured-read', expected: null, payload: { job: 55 } }])
      const keys = ['notice/captured-read'],
        pending = state.read(keys)
      keys[0] = '@owner'
      expect((await pending).map((row) => row.key)).toEqual(['notice/captured-read'])
    })
    it('captures original recovery prefixes before awaiting storage', async () => {
      await state.ingest([{ key: 'notice/captured-prefix', expected: null, payload: { job: 55 } }])
      const lease = await owner(),
        prefixes = ['notice/'],
        pending = state.recover(lease, 1, prefixes)
      prefixes[0] = 'receipt/'
      expect((await pending).map((row) => row.key)).toEqual(['notice/captured-prefix'])
    })
    it('creates permanent business roots atomically with the namespace', async () => {
      const seeded = new ListenerState(database, namespace + '-seed')
      await seeded.initialize([{ key: 'catalog/scopes', payload: { keys: [] } }])
      const before = await seeded.read(['catalog/scopes'])
      await seeded.initialize([{ key: 'catalog/scopes', payload: { keys: ['replacement'] } }])
      expect(await seeded.read(['catalog/scopes'])).toEqual(before)
      expect(before[0].payload).toEqual({ keys: [] })
      await database.transaction(namespace + '-seed', async (tx) => {
        const row = (await tx.get('catalog/scopes'))!
        await tx.remove(row.key, row.version)
      })
      await expect(seeded.initialize([{ key: 'catalog/scopes', payload: { keys: [] } }])).rejects.toBeInstanceOf(
        StateCorrupt,
      )
    })
    it('does not leave partial namespace roots after invalid bootstrap input', async () => {
      const ns = namespace + '-invalid',
        seeded = new ListenerState(database, ns)
      await expect(
        seeded.initialize([
          { key: 'catalog/scopes', payload: {} },
          { key: 'catalog/scopes', payload: {} },
        ]),
      ).rejects.toThrow('batch')
      expect(await database.transaction(ns, (tx) => tx.page('', 1))).toEqual([])
    })
    it('reads ingress versions without acquiring execution ownership', async () => {
      const [written] = await state.ingest([{ key: 'notice/lookup', expected: null, payload: { job: 9 } }])
      expect(await state.read(['notice/missing', 'notice/lookup'])).toEqual([written])
      await expect(state.read(['@owner'])).rejects.toThrow('keys')
      await expect(state.read(['notice/lookup', 'notice/lookup'])).rejects.toThrow('keys')
    })
    it('recovers requested key ranges without counting unrelated receipts', async () => {
      const lease = await owner()
      await state.ingest(
        Array.from({ length: 100 }, (_, index) => ({
          key: 'receipt/' + index,
          expected: null,
          payload: { digest: index },
        })),
      )
      await state.commit(lease, [
        { key: 'worker/a', expected: null, payload: {} },
        { key: 'worker_a/b', expected: null, payload: {} },
        { key: 'workeraa/b', expected: null, payload: {} },
      ])
      expect((await state.recover(lease, 1, ['worker/'])).map((row) => row.key)).toEqual(['worker/a'])
      expect((await state.recover(lease, 1, ['worker_a/'])).map((row) => row.key)).toEqual(['worker_a/b'])
      await expect(state.recover(lease, 1, ['worker%/'])).rejects.toThrow('prefix')
    })
    it('scans bounded metadata pages under the current namespace and execution lease', async () => {
      const lease = await owner()
      await state.commit(lease, [
        { key: 'replay/a', expected: null, payload: { a: 1 } },
        { key: 'replay/b', expected: null, payload: { a: 2 } },
        { key: 'replay/c', expected: null, payload: { a: 3 } },
        { key: 'replay_a/a', expected: null, payload: {} },
      ])
      expect((await state.scan(lease, { prefix: 'replay/', limit: 2 })).map((row) => row.key)).toEqual([
        'replay/a',
        'replay/b',
      ])
      expect(
        (await state.scan(lease, { prefix: 'replay/', after: 'replay/b', limit: 2 })).map((row) => row.key),
      ).toEqual(['replay/c'])
      expect(await state.scan(lease, { prefix: 'replay/', after: 'replay/c' })).toEqual([])
      for (const range of [
        { prefix: '@owner/' },
        { prefix: 'replay/', after: 'other/a' },
        { prefix: 'replay/', limit: 0 },
        { prefix: 'replay/', limit: 101 },
      ])
        await expect(state.scan(lease, range)).rejects.toThrow('scan')
      await expect(state.scan({ ...lease, namespace: 'another-app' }, { prefix: 'replay/' })).rejects.toBeInstanceOf(
        LeaseLost,
      )
      await expect(state.scan({ ...lease, owner: 'stranger' }, { prefix: 'replay/' })).rejects.toBeInstanceOf(LeaseLost)
    })
    it('captures metadata scan selectors and lease before asynchronous database work', async () => {
      const lease = await owner()
      await state.commit(lease, [
        { key: 'replay/a', expected: null, payload: {} },
        { key: 'replay/b', expected: null, payload: {} },
      ])
      const range = { prefix: 'replay/', after: '', limit: 1 },
        pending = state.scan(lease, range)
      Object.assign(range, { prefix: 'notice/', after: 'notice/z', limit: 100 })
      expect((await pending).map((row) => row.key)).toEqual(['replay/a'])
      const mutable = { ...lease, owner: 'not-the-owner' },
        denied = state.scan(mutable, { prefix: 'replay/' })
      Object.assign(mutable, lease)
      await expect(denied).rejects.toBeInstanceOf(LeaseLost)
    })
    it('rejects damaged metadata and an expired lease at the scan boundary', async () => {
      const lease = await owner()
      const [written] = await state.commit(lease, [{ key: 'replay/a', expected: null, payload: {} }])
      await database.transaction(namespace, (tx) =>
        tx.put({ ...written, schema: 2, version: randomUUID() }, written.version),
      )
      await expect(state.scan(lease, { prefix: 'replay/' })).rejects.toBeInstanceOf(StateCorrupt)
      await database.transaction(namespace, async (tx) => {
        const row = (await tx.get('@lease', true))!
        await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
      })
      await expect(state.scan(lease, { prefix: 'notice/' })).rejects.toBeInstanceOf(LeaseLost)
    })
    it('accepts ingress without a lease but rejects execution and reserved writes', async () => {
      const unauthorized = { namespace, owner: 'stranger', epoch: 1 }
      const [notice] = await state.ingest([{ key: 'notice/1', expected: null, payload: { job: 7 } }])
      await expect(
        state.commit(unauthorized, [{ key: 'worker/1', expected: null, payload: {} }]),
      ).rejects.toBeInstanceOf(LeaseLost)
      await expect(state.ingest([{ key: 'worker/1', expected: null, payload: {} }])).rejects.toThrow('ingress')
      await expect(state.ingest([{ key: '@owner', expected: null, payload: {} }])).rejects.toThrow('key')
      expect(await state.recover(await owner())).toEqual([notice])
    })
    it('limits transactional ingress to its validated target and record kinds', async () => {
      await expect(state.ingress('../escape', async () => undefined)).rejects.toThrow('Invalid ingress target')
      for (const key of ['worker/1', '@owner', 'notice/../bad?'])
        await expect(state.ingress('9/21', (tx) => tx.read([key]))).rejects.toThrow('Invalid ingress record kind')
      await expect(
        state.ingress('9/21', (tx) =>
          tx.write([
            { key: 'notice/a', expected: null, payload: {} },
            { key: 'worker/1', expected: null, payload: {} },
          ]),
        ),
      ).rejects.toThrow('Invalid ingress record kind')
      expect(await state.recover(await owner())).toEqual([])
    })
    it('reads and writes supported ingress records under an execution lease', async () => {
      const lease = await owner()
      const written = await state.ingress(
        '9/21',
        async (tx) => {
          expect(await tx.read(['job-fact/9/55'])).toEqual([])
          const rows = await tx.write([
            { key: 'job-fact/9/55', expected: null, payload: { status: 'queued' } },
            { key: 'demand/9/21/profile', expected: null, payload: { queued: 1 } },
            { key: 'runner-claim/9/91', expected: null, payload: { job: 55 } },
          ])
          expect(await tx.read(rows.map((row) => row.key))).toEqual(rows)
          return rows
        },
        lease,
      )
      expect(await state.recover(lease)).toEqual(written)
      await expect(
        state.ingress('9/21', async () => undefined, { ...lease, epoch: lease.epoch + 1 }),
      ).rejects.toBeInstanceOf(LeaseLost)
    })
    it('locks the namespace anchor when a custom adapter has no logical ingress lock', async () => {
      const anchorLocks: string[] = []
      const adapter: StateDatabase = {
        transaction: (ns, work, mode) =>
          database.transaction(
            ns,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (key, locked) => {
                  if (locked) anchorLocks.push(key)
                  return tx.get(key, locked)
                },
                page: (...args) => tx.page(...args),
                put: (...args) => tx.put(...args),
                remove: (...args) => tx.remove(...args),
              }),
            mode,
          ),
      }
      const custom = new ListenerState(adapter, namespace)
      const rows = await custom.ingress('9/21', (tx) =>
        tx.write([{ key: 'notice/custom', expected: null, payload: { job: 55 } }]),
      )
      expect(anchorLocks).toEqual(['@anchor'])
      expect(await state.read(['notice/custom'])).toEqual(rows)
    })
    it('rolls back a whole receipt batch on conflict', async () => {
      await state.ingest([{ key: 'notice/z', expected: null, payload: { job: 7 } }])
      await expect(
        state.ingest([
          { key: 'notice/a', expected: null, payload: { job: 8 } },
          { key: 'notice/z', expected: null, payload: { job: 9 } },
        ]),
      ).rejects.toBeInstanceOf(StateConflict)
      expect((await state.recover(await owner())).map((r) => r.key)).toEqual(['notice/z'])
    })
    it('rejects stale updates and settlement after deletion and reinsertion', async () => {
      const lease = await owner(),
        [original] = await state.commit(lease, [{ key: 'worker/1', expected: null, payload: { phase: 'requested' } }])
      await state.commit(lease, [{ key: original.key, expected: original.version }])
      const [replacement] = await state.commit(lease, [
        { key: original.key, expected: null, payload: { phase: 'unknown' } },
      ])
      expect(replacement.version).not.toBe(original.version)
      await expect(state.commit(lease, [{ key: original.key, expected: original.version }])).rejects.toBeInstanceOf(
        StateConflict,
      )
      expect(await state.recover(lease)).toEqual([replacement])
    })
    it('keeps unknown effects and permanent scopes through owner turnover', async () => {
      const first = (await state.acquire('first', 100))!
      await state.commit(first, [
        { key: 'worker/unknown', expected: null, payload: { phase: 'requested', operation: randomUUID() } },
        { key: 'scope/1', expected: null, payload: { organization: 'original' } },
      ])
      await new Promise((resolve) => setTimeout(resolve, 160))
      await expect(state.renew(first, 10_000)).rejects.toBeInstanceOf(LeaseLost)
      const next = (await state.acquire('next', 10_000))!
      expect(next.epoch).toBe(first.epoch + 1)
      await expect(state.commit(first, [{ key: 'worker/extra', expected: null, payload: {} }])).rejects.toBeInstanceOf(
        LeaseLost,
      )
      const rows = await state.recover(next)
      expect(rows.map((r) => r.key)).toEqual(['scope/1', 'worker/unknown'])
      await expect(state.commit(next, [{ key: 'scope/1', expected: rows[0].version }])).rejects.toThrow('permanent')
    })
    it('recovers all pages and rejects silent truncation', async () => {
      const lease = await owner()
      for (let batch = 0; batch < 3; batch++)
        await state.commit(
          lease,
          Array.from({ length: 75 }, (_, i) => ({
            key: `worker/${String(batch * 75 + i).padStart(3, '0')}`,
            expected: null,
            payload: { i },
          })),
        )
      expect(await state.recover(lease)).toHaveLength(225)
      await expect(state.recover(lease, 224)).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('refuses missing owner and orphaned records instead of creating a fresh root', async () => {
      await state.ingest([{ key: 'notice/1', expected: null, payload: { job: 1 } }])
      await database.transaction(namespace, async (tx) => {
        for (const key of ['@owner', '@anchor']) {
          const row = (await tx.get(key))!
          expect(await tx.remove(key, row.version)).toBe(true)
        }
      })
      await expect(state.initialize()).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('rejects unsupported schemas and isolated namespace access', async () => {
      const lease = await owner()
      const other = new ListenerState(database, namespace + '-other')
      await other.initialize()
      const alien = (await other.acquire('alien', 10_000))!
      await expect(state.commit(alien, [{ key: 'worker/1', expected: null, payload: {} }])).rejects.toBeInstanceOf(
        LeaseLost,
      )
      await database.transaction(namespace, async (tx) => {
        const row = (await tx.get('@anchor'))!
        await tx.put({ ...row, version: randomUUID(), schema: 99 }, row.version)
      })
      await expect(state.recover(lease)).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('binds a lease to its namespace even with the same owner and epoch', async () => {
      const first = (await state.acquire('shared-owner', 10_000))!
      const other = new ListenerState(database, namespace + '-other')
      await other.initialize()
      const foreign = (await other.acquire('shared-owner', 10_000))!
      expect({ owner: foreign.owner, epoch: foreign.epoch }).toEqual({ owner: first.owner, epoch: first.epoch })
      await expect(
        state.commit(foreign, [{ key: 'worker/foreign', expected: null, payload: {} }]),
      ).rejects.toBeInstanceOf(LeaseLost)
      expect(await state.recover(first)).toEqual([])
    })
    it('snapshots mutable payloads and rejects lossy or oversized JSON', async () => {
      const payload = { phase: 'requested' },
        writing = state.ingest([{ key: 'notice/1', expected: null, payload }])
      payload.phase = 'mutated'
      await writing
      expect((await state.recover(await owner()))[0].payload).toEqual({ phase: 'requested' })
      await expect(state.ingest([{ key: 'notice/2', expected: null, payload: { count: NaN } }])).rejects.toThrow('JSON')
      await expect(state.ingest([{ key: 'notice/2', expected: null, payload: 'x'.repeat(1_048_577) }])).rejects.toThrow(
        'limit',
      )
    })
    if (backend === 'sqlite')
      it('persists across connections with private DB, WAL and SHM files', async () => {
        await state.ingest([{ key: 'notice/restart', expected: null, payload: { job: 7 } }])
        for (const file of ['listener.sqlite', 'listener.sqlite-wal', 'listener.sqlite-shm'])
          expect(statSync(join(directory, file)).mode & 0o077).toBe(0)
        await local!.close()
        local = new SqliteStateDatabase(directory)
        state = new ListenerState(local, namespace)
        await state.initialize()
        expect((await state.recover(await owner()))[0].key).toBe('notice/restart')
      })
    if (backend === 'postgres') {
      it('checks actual lease time after waiting for the owner row lock', async () => {
        const lease = (await state.acquire('waiting-owner', 500))!
        let locked!: () => void, release!: () => void
        const hasLock = new Promise<void>((resolve) => {
          locked = resolve
        })
        const releaseLock = new Promise<void>((resolve) => {
          release = resolve
        })
        const holding = pg!.transaction(async (manager) => {
          await manager.query('SELECT 1 FROM ci_listener_state WHERE namespace=$1 AND record_key=$2 FOR UPDATE', [
            namespace,
            '@owner',
          ])
          locked()
          await releaseLock
        })
        await hasLock
        const write = state.commit(lease, [{ key: 'worker/late', expected: null, payload: {} }]).then(
          () => null,
          (error) => error,
        )
        try {
          await pg!.query('SELECT pg_sleep(0.65)')
        } finally {
          release()
          await holding
        }
        expect(await write).toBeInstanceOf(LeaseLost)
        expect(await state.recover((await state.acquire('successor', 10_000))!)).toEqual([])
      })
      it('keeps recovery pages consistent while another receiver commits ingress', async () => {
        const lease = await owner()
        for (let batch = 0; batch < 2; batch++)
          await state.ingest(
            Array.from({ length: 75 }, (_, i) => ({
              key: `notice/${String(batch * 75 + i).padStart(3, '0')}`,
              expected: null,
              payload: { job: batch * 75 + i },
            })),
          )
        let visited = false
        const instrumented: StateDatabase = {
          transaction: (ns, work, mode) =>
            database.transaction(
              ns,
              async (tx) => {
                const observed = Object.create(tx) as typeof tx
                observed.page = async (after, limit) => {
                  const rows = await tx.page(after, limit)
                  if (!visited) {
                    visited = true
                    await state.ingest([{ key: 'notice/zzz', expected: null, payload: { job: 999 } }])
                  }
                  return rows
                }
                return work(observed)
              },
              mode,
            ),
        }
        expect(await new ListenerState(instrumented, namespace).recover(lease)).toHaveLength(150)
        expect(await state.recover(lease)).toHaveLength(151)
      })
    }
  })
}
