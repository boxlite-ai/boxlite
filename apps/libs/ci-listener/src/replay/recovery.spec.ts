/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DataSource } from 'typeorm'
import { GitHubAppSource } from '../github-app'
import { ExecutionJournal } from '../execution/journal'
import { ExecutionScope } from '../execution/model'
import { StateDatabase } from '../state/database'
import { ListenerState, ExecutionLease } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { PostgresStateDatabase, postgresStateTable } from '../state/postgres'
import { ListenerInbox, verifyWebhook } from '../webhook'
import { AppDeliveryRecovery } from './recovery'
import { interval, item, itemPrefix, minute, progress, progressKey, retention } from './model'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const guid1 = '00000000-0000-4000-8000-000000000001'
const guid2 = '00000000-0000-4000-8000-000000000002'
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.DB_HOST ? describe.skip : describe
  suite('CI App delivery replay ' + backend, () => {
    let database: StateDatabase,
      state: ListenerState,
      lease: ExecutionLease,
      local: SqliteStateDatabase | undefined,
      pg: DataSource | undefined,
      directory: string | undefined,
      schema: string,
      namespace: string,
      clock: number,
      recovery: AppDeliveryRecovery,
      stop: AbortController,
      app: GitHubAppSource,
      allowed: Set<number>,
      rootAllowed: boolean,
      mode: string,
      pause: (() => void) | undefined
    const original = global.fetch
    let calls: { path: string; method: string }[],
      intents: { id: string; intent: unknown; attempts: unknown; nextAt: unknown }[],
      pages: Map<string, { rows: Record<string, unknown>[]; next?: string; status?: number }>,
      failures: Set<string>,
      report: jest.Mock
    const wire = (id = '1', guid = guid1, installation = 1, status = 503, time = clock) => ({
      id,
      guid,
      delivered_at: new Date(time).toISOString(),
      status_code: status,
      event: 'workflow_job',
      action: 'queued',
      installation_id: installation,
      repository_id: installation + 20,
    })
    const ack = async (id: string, guid: string, installation: number) => {
      const raw = Buffer.from(
        JSON.stringify({
          action: 'queued',
          installation: { id: installation },
          repository: { id: installation + 20, owner: { id: installation + 6 } },
          workflow_job: { id: installation * 100 + 55, run_id: 33, status: 'queued', labels: ['boxlite'] },
        }),
      )
      const secret = Buffer.alloc(32, 5)
      await new ListenerInbox(state).receive(
        verifyWebhook(
          {
            raw,
            delivery: guid,
            event: 'workflow_job',
            signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
          },
          secret,
        )!,
      )
    }
    const make = () =>
      new AppDeliveryRecovery({
        state,
        app: () => app,
        authorize: async (current, installation, signal) => {
          signal.throwIfAborted()
          await new ExecutionJournal(state).check(current)
          return rootAllowed && (installation === undefined || allowed.has(installation))
        },
        report,
        now: () => clock,
      })
    beforeEach(async () => {
      namespace = 'replay:' + randomUUID()
      clock = Date.now()
      calls = []
      intents = []
      pause = undefined
      allowed = new Set([1, 2])
      rootAllowed = true
      mode = 'ack'
      failures = new Set()
      report = jest.fn()
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-replay-'))
        local = new SqliteStateDatabase(directory)
        database = local
      } else {
        if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
          throw Error(`Disposable local PostgreSQL required: DB_HOST=${process.env.DB_HOST}`)
        schema = 'ci_replay_' + randomUUID().replaceAll('-', '')
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
      await new ExecutionJournal(state).initialize()
      lease = (await state.acquire('replay-owner', 300000))!
      pages = new Map([['', { rows: [wire()] }]])
      app = new GitHubAppSource({ issuer: 'replay-app', privateKey: () => keys.privateKey })
      global.fetch = jest.fn(async (input, options) => {
        const address = new URL(String(input)),
          method = options?.method ?? 'GET'
        calls.push({ path: address.pathname + address.search, method })
        if (address.pathname === '/app/hook/deliveries') {
          const page = structuredClone(pages.get(address.searchParams.get('cursor') ?? '') ?? { rows: [] })
          if (mode === 'pause')
            await new Promise<void>((resolve) => {
              pause = resolve
            })
          const headers: Record<string, string> = {}
          if (page.next)
            headers.link = `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${encodeURIComponent(page.next)}>; rel="next"`
          if (page.status === 429) headers['retry-after'] = '600'
          return new Response(JSON.stringify(page.rows), { status: page.status ?? 200, headers })
        }
        const match = /^\/app\/hook\/deliveries\/([0-9]+)\/attempts$/.exec(address.pathname)
        if (!match || method !== 'POST') return new Response('{}', { status: 404 })
        const id = match[1],
          delivery = [...pages.values()].flatMap((value) => value.rows).find((value) => String(value.id) === id)
        if (!delivery) return new Response('{}', { status: 404 })
        const [row] = await state.read([itemPrefix + delivery.guid])
        const value = row?.payload as Record<string, unknown> | undefined
        intents.push({ id, intent: value?.intent, attempts: value?.attempts, nextAt: value?.nextAt })
        if (failures.has(id)) return new Response('{}', { status: 404 })
        if (mode === 'lost-before') throw new Error('Response lost before receiver')
        if (mode !== 'accepted') await ack(id, String(delivery.guid), Number(delivery.installation_id))
        if (mode === 'lost-after') throw new Error('Response lost after receiver')
        return new Response(null, { status: 202 })
      }) as typeof fetch
      stop = new AbortController()
      recovery = make()
    })
    afterEach(async () => {
      pause?.()
      stop.abort()
      await recovery.close()
      global.fetch = original
      await local?.close()
      local = undefined
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
      if (pg?.isInitialized)
        try {
          await pg.query(`DROP SCHEMA "${schema}" CASCADE`)
        } finally {
          await pg.destroy()
          pg = undefined
        }
    })
    const posts = () => calls.filter((call) => call.method === 'POST')
    const entry = async (guid = guid1) => {
      const [row] = await state.read([itemPrefix + guid])
      return row ? item(row) : undefined
    }
    const checkpoint = async () => {
      const [row] = await state.read([progressKey])
      return row ? progress(row) : undefined
    }
    async function until(check: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + 3500
      while (Date.now() < deadline) {
        if (!stop.signal.aborted) recovery.step(lease, stop.signal)
        if (await check()) return
        await delay(1)
      }
      throw Error('Recovery did not reach observed condition: ' + JSON.stringify(calls.slice(-4)))
    }
    const scanned = async () => {
      const value = await checkpoint()
      return !!value && !value.scan && value.scanAt > clock
    }
    const restart = async () => {
      await recovery.close()
      stop = new AbortController()
      recovery = make()
    }
    it('isolates two Apps delivery checkpoints and pending items in a shared namespace', async () => {
      await until(scanned)
      await recovery.close()
      const [original] = await state.read([progressKey])
      const second = new AppDeliveryRecovery({
        state,
        app: () => app,
        prefix: 'replay-other/',
        authorize: async (current) => {
          await new ExecutionJournal(state).check(current)
          return true
        },
        report,
        now: () => clock,
      })
      const deadline = Date.now() + 3500
      try {
        let complete = false
        while (Date.now() < deadline) {
          second.step(lease, stop.signal)
          const [row] = await state.read(['replay-other/progress'])
          if (row && !progress(row, 'replay-other/').scan && progress(row, 'replay-other/').scanAt > clock) {
            complete = true
            break
          }
          await delay(1)
        }
        expect(complete).toBe(true)
        expect(await state.read([progressKey])).toEqual([original])
        expect(await state.read(['replay-other/item/' + guid1])).toHaveLength(1)
      } finally {
        await second.close()
      }
    })
    it('does not report a retention gap on the first boot when initialization advances the clock', async () => {
      const commit = state.commit.bind(state)
      const spy = jest.spyOn(state, 'commit').mockImplementation(async (owner, changes) => {
        const result = await commit(owner, changes)
        if (changes.some((change) => change.key === progressKey && change.expected === null)) clock += 10
        return result
      })
      try {
        await until(scanned)
        expect((await checkpoint())?.gaps).toBe(0)
        expect(report.mock.calls.some(([, operation]) => operation === 'replay-retention-gap')).toBe(false)
      } finally {
        spy.mockRestore()
      }
    })
    it('journals an intent before replay and persists one signed inbox job', async () => {
      await until(async () => !!(await state.read(['receipt/' + guid1])).length)
      expect(posts()).toHaveLength(1)
      expect(intents[0]).toMatchObject({ id: '1', attempts: 1 })
      expect(intents[0].intent).toMatch(/^[a-f0-9-]{36}$/)
      expect(intents[0].nextAt).toBe(clock + interval)
      const notices = await state.scan(lease, { prefix: 'notice/' })
      expect(notices).toHaveLength(1)
      expect(notices[0].payload).toMatchObject({ installationId: 1, repositoryId: 21, job: { id: 155, runId: 33 } })
    })
    it('continues empty pages and preserves a remote success over an older failed attempt', async () => {
      pages = new Map([
        ['', { rows: [], next: 'a' }],
        ['a', { rows: [wire('3', guid1, 1, 202)], next: 'b' }],
        ['b', { rows: [wire('1', guid1, 1, 503, clock - 1)] }],
      ])
      await until(scanned)
      expect((await entry())?.delivery.id).toBe('3')
      expect((await entry())?.done).toBe(true)
      expect(posts()).toHaveLength(0)
      expect(calls.filter((call) => call.method === 'GET')).toHaveLength(3)
    })
    it('does not treat POST 202 as completion and later observes success for ignored work', async () => {
      mode = 'accepted'
      await until(() => posts().length === 1)
      expect((await entry())?.done).toBe(false)
      expect(await state.read(['receipt/' + guid1])).toEqual([])
      pages.set('', { rows: [wire('2', guid1, 1, 202, clock + interval)] })
      clock += interval + 1
      await until(async () => (await entry())?.done === true)
      expect(posts()).toHaveLength(1)
      expect(await state.read(['receipt/' + guid1])).toEqual([])
    })
    it('stops replay after a lost response when the receiver already committed a receipt', async () => {
      mode = 'lost-after'
      await until(async () => !!(await checkpoint())?.notBefore)
      expect(posts()).toHaveLength(1)
      await restart()
      clock += minute + 1000
      await until(async () => !!(await checkpoint()) && (await checkpoint())!.retryAt > clock)
      clock += minute + 1
      await until(async () => (await entry())?.done === true)
      expect(posts()).toHaveLength(1)
    })
    it('recovers an uncertain request after restart without resetting its retry deadline', async () => {
      mode = 'lost-before'
      await until(async () => !!(await checkpoint())?.notBefore)
      const before = await entry()
      expect(before?.attempts).toBe(1)
      expect(posts()).toHaveLength(1)
      await restart()
      mode = 'ack'
      clock += minute + 1000
      await until(async () => {
        const value = await checkpoint()
        return !!value && value.retryAt > clock
      })
      expect(posts()).toHaveLength(1)
      clock += interval
      await until(async () => !!(await state.read(['receipt/' + guid1])).length)
      expect(posts()).toHaveLength(2)
      expect(await state.scan(lease, { prefix: 'notice/' })).toHaveLength(1)
    })
    it('persists rate-limit cooldown across restart without fetching a page early', async () => {
      pages.set('', { rows: [], status: 429 })
      await until(async () => ((await checkpoint())?.notBefore ?? 0) > clock)
      const count = calls.length,
        due = (await checkpoint())!.notBefore
      await restart()
      pages.set('', { rows: [] })
      clock += minute
      for (let i = 0; i < 5; i++) {
        recovery.step(lease, stop.signal)
        await delay(1)
      }
      expect(calls).toHaveLength(count)
      clock = due + 1
      await until(scanned)
      expect(calls.length).toBeGreaterThan(count)
    })
    it('retains page records after an interrupted checkpoint and repeats the page on restart', async () => {
      allowed.clear()
      const commit = state.commit.bind(state)
      let interrupted = false
      const spy = jest.spyOn(state, 'commit').mockImplementation(async (owner, changes) => {
        const result = await commit(owner, changes)
        if (!interrupted && changes.some((change) => change.key.startsWith(itemPrefix))) {
          interrupted = true
          stop.abort()
        }
        return result
      })
      await until(async () => !!(await entry()))
      await recovery.close()
      spy.mockRestore()
      expect((await checkpoint())?.scan?.cursor).toBe(null)
      await restart()
      await until(scanned)
      expect(await state.scan(lease, { prefix: itemPrefix })).toHaveLength(1)
      expect(calls.filter((call) => call.path === '/app/hook/deliveries?per_page=100')).toHaveLength(2)
    })
    it('rejects a cross-page cursor cycle without advancing the completed watermark', async () => {
      allowed.clear()
      pages = new Map([
        ['', { rows: [wire()], next: 'a' }],
        ['a', { rows: [], next: 'b' }],
        ['b', { rows: [], next: 'a' }],
      ])
      await until(async () => !!(await checkpoint())?.notBefore)
      const value = (await checkpoint())!
      expect(value.watermark).toBe(clock - retention)
      expect(value.scan).toBe(null)
      expect(await entry()).toBeDefined()
      expect(posts()).toHaveLength(0)
    })
    it('rejects changing page order and preserves the earlier page and watermark', async () => {
      allowed.clear()
      pages = new Map([
        ['', { rows: [wire('1', guid1, 1, 503, clock - 1)], next: 'a' }],
        ['a', { rows: [wire('2', guid2)] }],
      ])
      await until(async () => !!(await checkpoint())?.notBefore)
      expect((await checkpoint())?.watermark).toBe(clock - retention)
      expect(await entry()).toBeDefined()
      expect(await entry(guid2)).toBeUndefined()
    })
    it('restarts an expired cursor from the head while retaining queued metadata', async () => {
      allowed.clear()
      pages = new Map([
        ['', { rows: [wire()], next: 'expired' }],
        ['expired', { rows: [], status: 404 }],
      ])
      await until(async () => !!(await checkpoint())?.notBefore)
      expect((await checkpoint())?.watermark).toBe(clock - retention)
      pages.set('', { rows: [wire()] })
      clock += minute + 1000
      await until(scanned)
      expect(await entry()).toBeDefined()
    })
    it('skips denied installations so another installation can replay', async () => {
      pages.set('', { rows: [wire(), wire('2', guid2, 2)] })
      allowed.delete(1)
      await until(async () => !!(await state.read(['receipt/' + guid2])).length)
      expect(posts().map((call) => call.path)).toEqual(['/app/hook/deliveries/2/attempts'])
      expect((await entry())?.attempts).toBe(0)
    })
    it('keeps a local delivery 404 from cooling down another installation', async () => {
      pages.set('', { rows: [wire(), wire('2', guid2, 2)] })
      failures.add('1')
      await until(async () => !!(await state.read(['receipt/' + guid2])).length)
      expect(posts()).toHaveLength(2)
      expect((await entry())?.done).toBe(false)
      expect((await checkpoint())!.notBefore).toBeLessThanOrEqual(clock)
    })
    it('expires only recovery metadata while retaining the original notice and allocation', async () => {
      allowed.clear()
      await ack('1', guid2, 1)
      const scope: ExecutionScope = {
        binding: 'b',
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
      const journal = new ExecutionJournal(state),
        key = await journal.define(lease, scope)
      const allocation = (await journal.reserve(
        lease,
        key,
        { repository: 21, run: 33, job: 155 },
        testCapacity({ account: 1, tenant: 1 }),
      ))!
      const [before] = await state.read([allocation.record.key])
      await until(scanned)
      clock += retention + 1
      await until(async () => !(await entry()))
      expect(await state.read([allocation.record.key])).toEqual([before])
      expect(await state.read(['notice/1/155'])).toHaveLength(1)
      expect((await inspectJournal(state, lease)).allocations.size).toBe(1)
      expect(report.mock.calls.some(([, op]) => op === 'replay-expired/' + guid1)).toBe(true)
    })
    it('rejects unsupported persisted metadata instead of replacing it with defaults', async () => {
      allowed.clear()
      await until(scanned)
      const [row] = await state.read([itemPrefix + guid1])
      await state.commit(lease, [
        { key: row.key, expected: row.version, payload: { ...(row.payload as object), version: 2 } },
      ])
      clock += minute + 1
      await until(() => report.mock.calls.some(([, op]) => op === 'replay-retry'))
      expect((await state.read([row.key]))[0].payload).toMatchObject({ version: 2 })
      expect(posts()).toHaveLength(0)
    })
    it('does not block step while fetching and discards a late result after epoch turnover', async () => {
      mode = 'pause'
      recovery.step(lease, stop.signal)
      const limit = Date.now() + 2000
      while (!pause && Date.now() < limit) await delay(1)
      expect(pause).toBeDefined()
      expect(await entry()).toBeUndefined()
      await database.transaction(namespace, async (tx) => {
        const row = (await tx.get('@lease', true))!
        await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
      })
      lease = (await state.acquire('next-owner', 300000))!
      recovery.step(lease, stop.signal)
      pages.set('', { rows: [wire('2', guid2)] })
      mode = 'ack'
      pause!()
      await until(async () => !!(await entry(guid2)))
      expect(await entry()).toBeUndefined()
    })
    it.each(['installation', 'action'])('rejects changed %s metadata under an existing GUID', async (field) => {
      allowed.clear()
      if (field === 'action') {
        const first = wire()
        first.event = 'installation'
        first.action = 'created'
        pages.set('', { rows: [first] })
      }
      await until(scanned)
      // Stop the previous tick before injecting the next page; unrelated deferral must not race this assertion.
      await recovery.close()
      const [before] = await state.read([itemPrefix + guid1])
      const changed = wire('2', guid1, field === 'installation' ? 2 : 1, 503, clock + interval)
      if (field === 'action') {
        changed.event = 'installation'
        changed.action = 'deleted'
      }
      pages.set('', { rows: [changed] })
      clock += interval + 1
      const [schedule] = await state.read([progressKey]),
        value = progress(schedule)
      value.turn = 'page'
      await state.commit(lease, [
        {
          key: schedule.key,
          expected: schedule.version,
          payload: value as unknown as import('../state/database').Json,
        },
      ])
      await restart()
      await until(() => report.mock.calls.some(([, operation]) => operation === 'replay-page'))
      expect(await state.read([before.key])).toEqual([before])
      expect(posts()).toHaveLength(0)
    })
    it('rejects unsupported progress schema without overwriting its checkpoint', async () => {
      allowed.clear()
      await until(scanned)
      await recovery.close()
      const [before] = await state.read([progressKey])
      const [damaged] = await state.commit(lease, [
        { key: before.key, expected: before.version, payload: { ...(before.payload as object), version: 2 } },
      ])
      const count = calls.length
      clock += minute + 1
      await restart()
      await until(() => report.mock.calls.some(([, operation]) => operation === 'replay-state'))
      expect(await state.read([progressKey])).toEqual([damaged])
      expect(calls).toHaveLength(count)
    })
    it('bounds cursor history without declaring the unfinished scan complete', async () => {
      allowed.clear()
      pages.set('', { rows: [wire()], next: 'next' })
      await until(async () => (await checkpoint())?.scan?.cursor === 'next')
      await recovery.close()
      const [before] = await state.read([progressKey]),
        value = progress(before)
      value.scan!.seen = Array.from({ length: 10000 }, (_, index) => index.toString(16).padStart(64, '0'))
      value.turn = 'page'
      await state.commit(lease, [
        { key: before.key, expected: before.version, payload: value as unknown as import('../state/database').Json },
      ])
      const count = calls.length
      await restart()
      await until(async () => ((await checkpoint())?.notBefore ?? 0) > clock)
      expect((await checkpoint())?.watermark).toBe(clock - retention)
      expect((await checkpoint())?.scan).toBe(null)
      expect(calls).toHaveLength(count)
    })
    it('does not issue HTTP requests when the root authority is denied', async () => {
      rootAllowed = false
      await until(() => report.mock.calls.length > 0)
      expect(calls).toEqual([])
      expect(await state.read([progressKey])).toEqual([])
    })
  })
}
