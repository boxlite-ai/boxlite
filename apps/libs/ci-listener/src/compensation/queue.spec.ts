/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { ExecutionScope } from '../execution/model'
import { LeaseLost, StateCorrupt, StateDatabase } from '../state/database'
import { PostgresStateDatabase, postgresStateTable } from '../state/postgres'
import { SqliteStateDatabase } from '../state/sqlite'
import { ExecutionLease, ListenerState } from '../state/store'
import { RepositoryScanQueue } from './queue'

const url = process.env.CI_CONNECT_TEST_DATABASE_URL
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !url ? describe.skip : describe
  suite(`CI repository compensation queue ${backend}`, () => {
    let directory: string, schema: string, namespace: string, local: SqliteStateDatabase | undefined
    let connections: DataSource[], database: StateDatabase, state: ListenerState, main: ExecutionLease
    let queue: RepositoryScanQueue, second: RepositoryScanQueue, now: number, pages: { prefix: string; limit: number }[]
    const scope = (installation = 1, repos = [21]): ExecutionScope => ({
      binding: 'binding-' + installation,
      generation: 1,
      organization: 'tenant',
      actor: 'actor',
      installation: { id: installation, account: { id: installation + 6, login: 'owner', type: 'Organization' } },
      runners: {
        kind: 'organization',
        account: { id: installation + 6, login: 'owner' },
        group: 5,
        repositories: repos,
        allowPrivate: true,
        allowPublic: false,
      },
    })
    const clock = (db: StateDatabase): StateDatabase => ({
      transaction: (ns, work, mode) =>
        db.transaction(
          ns,
          (tx) =>
            work({
              now: async () => now,
              get: (...args) => tx.get(...args),
              page: (...args) => {
                pages.push({ prefix: args[2] ?? '', limit: args[1] })
                return tx.page(...args)
              },
              put: (...args) => tx.put(...args),
              remove: (...args) => tx.remove(...args),
            }),
          mode,
        ),
    })
    beforeEach(async () => {
      now = Date.now()
      namespace = 'scan-test:' + randomUUID()
      pages = []
      connections = []
      let other: StateDatabase
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-scans-'))
        local = new SqliteStateDatabase(directory)
        database = clock(local)
        other = database
      } else {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
          throw new Error('Disposable local PostgreSQL required')
        schema = 'ci_scans_' + randomUUID().replaceAll('-', '')
        for (let i = 0; i < 2; i++)
          connections.push(
            await new DataSource({
              type: 'postgres',
              url,
              extra: { options: `-c search_path=${schema},public` },
            }).initialize(),
          )
        await connections[0].query(`CREATE SCHEMA "${schema}"`)
        await connections[0].query(postgresStateTable)
        database = clock(new PostgresStateDatabase(connections[0]))
        other = clock(new PostgresStateDatabase(connections[1]))
      }
      state = new ListenerState(database, namespace)
      await state.initialize()
      main = (await state.acquire('main-scheduler', 300000))!
      queue = state.scans()
      second = new ListenerState(other, namespace).scans()
    })
    afterEach(async () => {
      await local?.close()
      local = undefined
      if (directory) rmSync(directory, { recursive: true, force: true })
      if (connections.length) {
        await connections[0].query(`DROP SCHEMA "${schema}" CASCADE`)
        await Promise.all(connections.map((db) => db.destroy()))
      }
    })
    const sync = async (definition = scope()) => queue.synchronize(main, 'app', definition.binding, [definition])
    const job = (repository = 21, run = 33) => ({
      repository,
      run,
      job: 55,
      status: 'queued' as const,
      labels: ['boxlite-ci-runner'],
      runner: null,
    })
    const owner = async () => {
      const claim = await queue.claim('scanner-a')
      expect(claim).toBeDefined()
      return claim!
    }

    it('claims independently of the existing main scheduler lease', async () => {
      await sync()
      expect(await state.acquire('another-scheduler', 300000)).toBeUndefined()
      const claim = await owner()
      await second.publish(claim, [job()], ['boxlite-ci-runner'])
      expect((await state.read(['notice/1/55']))[0].payload).toMatchObject({ repositoryId: 21 })
      expect(await state.read(['usage/global'])).toEqual([])
    })
    it('stores one immutable scope definition rather than copying its repository list into every task', async () => {
      await sync(
        scope(
          1,
          Array.from({ length: 40 }, (_, i) => i + 1),
        ),
      )
      const tasks = await database.transaction(namespace, (tx) => tx.page('', 100, 'scan/task/'))
      expect(tasks).toHaveLength(40)
      expect(tasks.every((row) => typeof (row.payload as { scope: unknown }).scope === 'string')).toBe(true)
      const scopes = await database.transaction(namespace, (tx) => tx.page('', 100, 'scan/scope/'))
      expect(scopes).toHaveLength(1)
    })
    it('resumes canceled catalog publication at its committed batch without exposing partial work', async () => {
      const abort = new AbortController(),
        definition = scope(
          1,
          Array.from({ length: 40 }, (_, i) => i + 1),
        )
      let writes = 0,
        taskReads = 0
      const observed: StateDatabase = {
        transaction: (ns, work, mode) =>
          database.transaction(
            ns,
            (tx) =>
              work({
                now: () => tx.now(),
                get: (...args) => {
                  if (args[0].startsWith('scan/task/')) taskReads++
                  return tx.get(...args)
                },
                page: (...args) => tx.page(...args),
                put: async (...args) => {
                  const result = await tx.put(...args)
                  if (args[0].key.startsWith('scan/task/') && ++writes === 25) abort.abort()
                  return result
                },
                remove: (...args) => tx.remove(...args),
              }),
            mode,
          ),
      }
      const publishing = new ListenerState(observed, namespace).scans()
      await expect(
        publishing.synchronize(main, 'app', definition.binding, [definition], abort.signal),
      ).rejects.toThrow()
      expect(writes).toBe(25)
      expect(await second.claim('partial')).toBeUndefined()
      taskReads = 0
      await publishing.synchronize(main, 'app', definition.binding, [definition], new AbortController().signal)
      expect(taskReads).toBe(15)
      expect((await second.claim('complete'))?.scope.binding).toBe(definition.binding)
    })
    it('has one winner across independent consumers and permits another installation', async () => {
      await sync()
      await sync(scope(2, [22]))
      const claims = await Promise.all([queue.claim('replica-a'), second.claim('replica-b')])
      const actual = claims.filter((claim) => claim !== undefined)
      expect(new Set(actual.map((claim) => claim!.id)).size).toBe(actual.length)
      for (let i = 0; i < 2 && actual.length < 2; i++) {
        const next = await second.claim('replica-c')
        if (next) actual.push(next)
      }
      expect(new Set(actual.map((claim) => claim!.scope.installation.id))).toEqual(new Set([1, 2]))
      expect(await queue.claim('replica-d')).toBeUndefined()
    })
    it('returns only one winner for concurrent claims of the same repository', async () => {
      await sync()
      const results = await Promise.all([queue.claim('first'), second.claim('second')])
      expect(results.filter(Boolean)).toHaveLength(1)
    })
    it('serializes repositories of the same installation across replicas', async () => {
      await sync(scope(1, [21, 22]))
      const claim = await owner()
      expect(await second.claim('replica-b')).toBeUndefined()
      await queue.finish(claim, { success: true, intervalMs: 300000 })
      now += 60000
      const next = await second.claim('replica-b')
      expect(next?.repository).toBe(claim.repository === 21 ? 22 : 21)
    })
    it('preserves successful deadlines through restart and repeated discovery', async () => {
      await sync()
      const claim = await owner()
      await queue.finish(claim, { success: true, intervalMs: 300000 })
      await sync()
      now += 299999
      expect(await second.claim('restarted')).toBeUndefined()
      now += 1
      expect((await second.claim('restarted'))?.epoch).toBe(2)
    })
    it('fences expired publishers and the former owner after takeover', async () => {
      await sync()
      const old = await owner()
      now += 60001
      await expect(queue.publish(old, [job()], ['boxlite-ci-runner'])).rejects.toBeInstanceOf(LeaseLost)
      const next = await second.claim('replacement')
      expect(next?.epoch).toBe(old.epoch + 1)
      await expect(queue.finish(old, { success: true, intervalMs: 300000 })).rejects.toBeInstanceOf(LeaseLost)
      await second.publish(next!, [job()], ['boxlite-ci-runner'])
    })
    it('rejects results after a binding snapshot changes or is removed', async () => {
      await sync()
      const old = await owner()
      const changed = scope()
      changed.generation++
      await sync(changed)
      await expect(queue.publish(old, [job()], ['boxlite-ci-runner'])).rejects.toBeInstanceOf(LeaseLost)
      await queue.reconcile(main, [])
      expect(await second.claim('other')).toBeUndefined()
      expect(await state.read(['notice/1/55'])).toEqual([])
    })
    it('activates healthy bindings without waiting for another binding and disables a successful empty catalog', async () => {
      await sync()
      expect((await owner()).scope.binding).toBe('binding-1')
      await queue.synchronize(main, 'app', 'binding-1', [])
      now += 60001
      expect(await second.claim('other')).toBeUndefined()
    })
    it('accepts matching ingress and rejects a different repository even inside one organization', async () => {
      await sync(scope(1, [21, 22]))
      const claim = await owner()
      const candidate = job(claim.repository)
      await queue.publish(claim, [candidate], ['boxlite-ci-runner'])
      await queue.publish(claim, [candidate], ['boxlite-ci-runner'])
      const [prior] = await state.read(['notice/1/55'])
      await state.ingest([
        {
          key: prior.key,
          expected: prior.version,
          payload: {
            installationId: 1,
            accountId: 7,
            repositoryId: claim.repository === 21 ? 22 : 21,
            job: { id: 55, runId: 33 },
          },
        },
      ])
      await expect(queue.publish(claim, [candidate], ['boxlite-ci-runner'])).rejects.toBeInstanceOf(StateCorrupt)
    })
    it('shares installation backoff while another installation proceeds', async () => {
      await sync(scope(1, [21, 22]))
      const claim = await owner()
      await queue.finish(claim, { success: false, intervalMs: 300000, retryAt: now + 120000 })
      await sync(scope(2, [23]))
      const healthy = (await second.claim('other'))!
      expect(healthy.scope.installation.id).toBe(2)
      await second.finish(healthy, { success: true, intervalMs: 300000 })
      now += 119999
      expect(await queue.claim('retry')).toBeUndefined()
      now += 1
      expect((await queue.claim('retry'))?.scope.installation.id).toBe(1)
    })
    it('moves busy candidates out of the due head with bounded queries', async () => {
      await sync(
        scope(
          1,
          Array.from({ length: 40 }, (_, i) => 100 + i),
        ),
      )
      pages = []
      const held = await owner()
      await sync(scope(2, [999]))
      let other
      for (let i = 0; i < 5 && !other; i++) other = await second.claim('other')
      expect(other?.scope.installation.id).toBe(2)
      expect(held.scope.installation.id).toBe(1)
      expect(pages.filter((page) => page.prefix === 'scan/due/').every((page) => page.limit === 16)).toBe(true)
      expect(pages.some((page) => page.prefix === '' || page.prefix === 'scope/')).toBe(false)
    })
    it('can retire its original credential after lease expiry without deleting a replacement', async () => {
      await sync()
      const old = await owner(),
        operation = randomUUID(),
        key = `credential/scan/${old.id}/${operation}`
      const port = queue.credentials(old)
      const [intent] = await port.commit(old, [
        { key, expected: null, payload: { operation, purpose: { kind: 'jobs', repository: 21 }, phase: 'requested' } },
      ])
      now += 60001
      const next = (await second.claim('replacement'))!
      const otherOperation = randomUUID(),
        otherKey = `credential/scan/${next.id}/${otherOperation}`
      const [replacement] = await second.credentials(next).commit(next, [
        {
          key: otherKey,
          expected: null,
          payload: { operation: otherOperation, purpose: { kind: 'jobs', repository: 21 }, phase: 'requested' },
        },
      ])
      await port.commit(old, [{ key, expected: intent.version }])
      await port.commit(old, [{ key, expected: intent.version }])
      await expect(port.commit(old, [{ key: otherKey, expected: replacement.version }])).rejects.toThrow()
      expect(await state.read([otherKey])).toHaveLength(1)
      await expect(port.commit(old, [{ key: 'worker/forged', expected: null, payload: {} }])).rejects.toThrow()
      await expect(
        port.commit(old, [{ key, expected: null, payload: { operation, purpose: { kind: 'jobs', repository: 21 } } }]),
      ).rejects.toBeInstanceOf(LeaseLost)
    })
    it('collects only expired credential metadata and bounded old membership pages', async () => {
      await sync()
      const claim = await owner(),
        operation = randomUUID(),
        key = `credential/scan/${claim.id}/${operation}`
      await queue.credentials(claim).commit(claim, [
        {
          key,
          expected: null,
          payload: { operation, purpose: { kind: 'jobs', repository: 21 }, phase: 'requested' },
        },
      ])
      await queue.collect()
      expect(await state.read([key])).toHaveLength(1)
      now += 7200001
      await queue.collect()
      expect(await state.read([key])).toEqual([])
    })
  })
}
