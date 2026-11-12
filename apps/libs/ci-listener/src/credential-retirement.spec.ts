/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { CredentialCollector } from './credential-retirement'
import { ListenerCredentials } from './credentials'
import { GitHubAppSource } from './github-app'
import { ListenerState, ExecutionLease } from './state/store'
import { LeaseLost, StateConflict, StateCorrupt, StateDatabase, StateRecord } from './state/database'
import { SqliteStateDatabase } from './state/sqlite'
import { PostgresStateDatabase, postgresStateTable } from './state/postgres'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const installation = {
  id: 7,
  account: { id: 8, login: 'owner', type: 'User' },
  suspended_at: null,
  permissions: { metadata: 'read', actions: 'read', administration: 'write' },
}
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.DB_HOST ? describe.skip : describe
  suite(`CI credential collection ${backend}`, () => {
    let database: StateDatabase, state: ListenerState, lease: ExecutionLease, namespace: string
    let local: SqliteStateDatabase | undefined, pg: DataSource | undefined, directory: string, schema: string
    let clock: number, issuedAt: number, failIssue: boolean
    let providers: ListenerCredentials[]
    const originalFetch = global.fetch
    const controlled = (): StateDatabase => ({
      transaction: (ns, work, mode) =>
        database.transaction(
          ns,
          (tx) => {
            const wrapped = Object.create(tx) as typeof tx
            wrapped.now = async () => clock
            return work(wrapped)
          },
          mode,
        ),
    })
    beforeEach(async () => {
      namespace = 'app:' + randomUUID()
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-credential-collection-'))
        local = new SqliteStateDatabase(directory)
        database = local
      } else {
        if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
          throw new Error('Disposable local PostgreSQL required')
        schema = 'ci_credentials_' + randomUUID().replaceAll('-', '')
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
      clock = issuedAt = Date.now()
      providers = []
      failIssue = false
      global.fetch = jest.fn(async (input, options) => {
        const path = new URL(String(input)).pathname
        if (path === '/app/installations/7') return new Response(JSON.stringify(installation))
        if (path.endsWith('/access_tokens')) {
          if (failIssue) throw new Error('unknown issuance outcome')
          const request = JSON.parse(String(options?.body))
          return new Response(
            JSON.stringify({
              token: 'private-collection-test-token',
              expires_at: new Date(issuedAt + 120000).toISOString(),
              permissions: { ...request.permissions, metadata: 'read' },
              repositories: request.repository_ids.map((id: number) => ({ id })),
            }),
            { status: 201 },
          )
        }
        if (path === '/installation/token') return new Response(null, { status: 204 })
        throw new Error('Unexpected GitHub test route')
      }) as typeof fetch
      state = new ListenerState(controlled(), namespace, 1)
      await state.initialize()
      await state.activate()
      lease = (await state.acquire('issuer', 300000))!
    })
    afterEach(async () => {
      for (const provider of providers) await provider.close().catch(() => {})
      global.fetch = originalFetch
      await local?.close()
      local = undefined
      if (directory) rmSync(directory, { recursive: true, force: true })
      if (pg?.isInitialized) {
        try {
          await pg.query(`DROP SCHEMA "${schema}" CASCADE`)
        } finally {
          await pg.destroy()
        }
        pg = undefined
      }
    })
    const issue = async (kind: 'app' | 'pat' = 'app', owner = 'scope/test') => {
      const app = new GitHubAppSource({ issuer: 'test-app', privateKey: () => keys.privateKey, now: () => issuedAt })
      const provider = new ListenerCredentials(
        state,
        lease,
        owner,
        kind === 'app'
          ? { kind, app, installation: await app.installation(7) }
          : { kind, repository: 11, token: () => 'user-managed-pat' },
      )
      providers.push(provider)
      await provider.open({ kind: 'jobs', repository: 11 })
      return (await state.scan(lease, { prefix: 'credential/' + owner + '/' }))[0]
    }
    const takeover = async () => {
      state = new ListenerState(controlled(), namespace, 2)
      await state.activate()
      lease = (await state.acquire('collector', 300000))!
    }
    const change = async (row: StateRecord, update: Record<string, unknown>) => {
      const payload = { ...(row.payload as Record<string, unknown>) }
      for (const [key, value] of Object.entries(update)) {
        if (value === undefined) delete payload[key]
        else payload[key] = value
      }
      return (
        await state.commit(lease, [
          {
            key: row.key,
            expected: row.version,
            payload: payload as any,
          },
        ])
      )[0]
    }
    it('observes deployment retirement without mutating ownership or retiring same-generation followers', async () => {
      const roots = () =>
        database.transaction(namespace, async (tx) => [await tx.get('@owner'), await tx.get('@lease')])
      const original = state
      const same = new ListenerState(controlled(), namespace, 1)
      const future = new ListenerState(controlled(), namespace, 3)
      const before = await roots()
      expect(await original.superseded()).toBe(false)
      expect(await same.superseded()).toBe(false)
      expect(await future.superseded()).toBe(false)
      expect(await roots()).toEqual(before)
      await takeover()
      const activated = await roots()
      expect(await original.superseded()).toBe(true)
      expect(await same.superseded()).toBe(true)
      expect(await state.superseded()).toBe(false)
      expect(await future.superseded()).toBe(false)
      expect(await roots()).toEqual(activated)
    })
    it('uses database time and collects at the exact expiry boundary after takeover', async () => {
      const row = await issue()
      await takeover()
      const collector = new CredentialCollector(state)
      clock = issuedAt + 119999
      await collector.step(lease)
      expect(await state.read([row.key])).toHaveLength(1)
      // The host wall-clock remains unchanged while the storage clock advances.
      clock++
      await collector.step(lease)
      expect(await state.read([row.key])).toEqual([])
      await collector.step(lease)
      expect(await state.read([row.key])).toEqual([])
    })
    it.each(['app', 'pat'] as const)('preserves the exact current %s holder until it closes', async (kind) => {
      const row = await issue(kind)
      clock = issuedAt + 120001
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toHaveLength(1)
      await providers[0].close()
      expect(await state.read([row.key])).toEqual([])
    })
    it('collects stale PAT borrows without revoking the user token or changing resource records', async () => {
      const row = await issue('pat')
      const [worker] = await state.commit(lease, [
        { key: 'worker/untouched', expected: null, payload: { capacity: 1 } },
      ])
      await takeover()
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toEqual([])
      expect(await state.read([worker.key])).toEqual([worker])
      expect(jest.mocked(global.fetch).mock.calls.some(([url]) => String(url).endsWith('/installation/token'))).toBe(
        false,
      )
      await expect(providers[0].close()).resolves.toBeUndefined()
    })
    it.each(['requested', 'invalid-expiry', 'legacy-pat'] as const)(
      'retains metadata without %s cleanup proof',
      async (kind) => {
        let row = await issue(kind === 'legacy-pat' ? 'pat' : 'app')
        row = await change(
          row,
          kind === 'requested'
            ? { phase: 'requested' }
            : kind === 'invalid-expiry'
              ? { expiresAt: 'unknown' }
              : { holder: undefined },
        )
        await takeover()
        clock = issuedAt + 120001
        await new CredentialCollector(state).step(lease)
        expect(await state.read([row.key])).toEqual([row])
      },
    )
    it('collects expired legacy App metadata with no holder information', async () => {
      let row = await issue()
      row = await change(row, { holder: undefined })
      await takeover()
      clock = issuedAt + 120000
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toEqual([])
    })
    it('retains an expiry that predates the actual issuance request', async () => {
      let row = await issue()
      row = await change(row, { expiresAt: issuedAt - 1 })
      await takeover()
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toEqual([row])
    })
    it.each(['epoch', 'deployment'] as const)('retains a PAT holder with an unproven future %s', async (field) => {
      let row = await issue('pat')
      await takeover()
      row = await change(row, {
        holder: {
          owner: 'future-holder',
          epoch: field === 'epoch' ? lease.epoch + 1 : lease.epoch - 1,
          deployment: field === 'deployment' ? 3 : 1,
        },
      })
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toEqual([row])
    })
    it('retains an actual unknown token issuance outcome after takeover', async () => {
      failIssue = true
      await expect(issue()).rejects.toMatchObject({ uncertain: true })
      const rows = await state.scan(lease, { prefix: 'credential/' })
      expect(rows).toHaveLength(1)
      await takeover()
      clock = issuedAt + 120001
      await new CredentialCollector(state).step(lease)
      expect(await state.read([rows[0].key])).toEqual(rows)
    })
    it('makes progress past sixteen retained records and wraps its cursor', async () => {
      const retained: StateRecord[] = []
      for (let index = 0; index < 16; index++) {
        const row = await issue('app', 'scope/a' + String(index).padStart(2, '0'))
        retained.push(await change(row, { phase: 'requested' }))
      }
      const expired = await issue('app', 'scope/z')
      await takeover()
      clock = issuedAt + 120000
      const collector = new CredentialCollector(state)
      await collector.step(lease)
      expect(await state.read([expired.key])).toHaveLength(1)
      await collector.step(lease)
      expect(await state.read([expired.key])).toEqual([])
      await collector.step(lease)
      await collector.step(lease)
      expect(await state.read(retained.map((row) => row.key))).toHaveLength(16)
    })
    it('leaves independently leased scan credentials to their original collector', async () => {
      const row = await issue('app', 'scan/' + 'a'.repeat(64))
      await takeover()
      clock = issuedAt + 120000
      await new CredentialCollector(state).step(lease)
      expect(await state.read([row.key])).toEqual([row])
    })
    it('does not delete a record changed after its scan', async () => {
      const row = await issue()
      await takeover()
      clock = issuedAt + 120000
      const scan = state.scan.bind(state)
      const intercept = jest.spyOn(state, 'scan').mockImplementationOnce(async (...args) => {
        const rows = await scan(...args)
        await change(row, { expiresAt: clock + 60000 })
        return rows
      })
      await expect(new CredentialCollector(state).step(lease)).rejects.toBeInstanceOf(StateConflict)
      intercept.mockRestore()
      expect((await state.read([row.key]))[0].payload).toMatchObject({ expiresAt: clock + 60000 })
    })
    it('rejects a stale collector lease without deleting metadata', async () => {
      const row = await issue()
      const stale = lease
      await takeover()
      clock = issuedAt + 120000
      await expect(new CredentialCollector(state).step(stale)).rejects.toBeInstanceOf(LeaseLost)
      expect(await state.read([row.key])).toEqual([row])
    })
    it.each([
      { operation: 'different' },
      { holder: { owner: 'invalid owner', epoch: 1 } },
      { purpose: { kind: 'unknown' } },
      { purpose: { kind: ['jobs'], repository: 11 } },
      { phase: ['issued'] },
    ])('preserves malformed credential metadata: %j', async (update) => {
      let row = await issue()
      row = await change(row, update)
      await takeover()
      clock = issuedAt + 120000
      await expect(new CredentialCollector(state).step(lease)).rejects.toBeInstanceOf(StateCorrupt)
      expect(await state.read([row.key])).toEqual([row])
    })
  })
}
