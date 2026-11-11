/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { ListenerState } from './state/store'
import { StateDatabase, StateConflict } from './state/database'
import { SqliteStateDatabase } from './state/sqlite'
import { PostgresStateDatabase, postgresStateTable } from './state/postgres'
import { ciWakeHint, ListenerInbox, verifyWebhook } from './webhook'

const secret = randomBytes(32)
const payload = () => ({
  action: 'queued',
  installation: { id: 9 },
  repository: { id: 21, owner: { id: 7 } },
  workflow_job: { id: 55, run_id: 33, status: 'queued', labels: ['boxlite'], name: '中文 Unicode' },
})
const signed = (value: unknown = payload(), delivery: string = randomUUID(), event = 'workflow_job') => {
  const raw = Buffer.from(JSON.stringify(value, null, 2))
  return { raw, signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'), delivery, event }
}
describe('CI shared webhook verification', () => {
  it('recognizes signed custom resources and rejects conflicting or invalid requests', () => {
    const body = payload()
    body.workflow_job.labels = ['boxlite-2vcpu-4gbmem-10gbdisk']
    expect(verifyWebhook(signed(body), secret)?.hint.job).toEqual({ id: 55, runId: 33 })
    for (const labels of [['boxlite', ...body.workflow_job.labels], ['boxlite-17vcpu-4gbmem-10gbdisk']]) {
      body.workflow_job.labels = labels
      expect(() => verifyWebhook(signed(body), secret)).toThrow('Invalid CI resource labels')
    }
  })
  it.each([[], ['signed body'], '{}', { length: 1 }, null])('rejects a non-Buffer request body %j', (raw) => {
    expect(() => verifyWebhook({ ...signed(), raw: raw as Buffer }, secret)).toThrow('Raw webhook body required')
  })
  it('verifies original bytes and normalizes a GitHub delivery identifier', () => {
    const notification = verifyWebhook(signed(payload(), 'A1234567-1111-2222-3333-444444444444'), secret)!
    expect(notification).toMatchObject({
      delivery: 'a1234567-1111-2222-3333-444444444444',
      hint: { installationId: 9, accountId: 7, repositoryId: 21, job: { id: 55, runId: 33 } },
    })
  })
  it.each(['different-body', 'wrong-signature', 'oversize', 'invalid-delivery', 'malformed-json'])(
    'rejects %s before generating a hint',
    (kind) => {
      const input = signed()
      if (kind === 'different-body') input.raw = Buffer.from('{}')
      if (kind === 'wrong-signature') input.signature = 'sha256=' + '0'.repeat(64)
      if (kind === 'oversize') input.raw = Buffer.alloc(1_048_577)
      if (kind === 'invalid-delivery') input.delivery = '../../record'
      if (kind === 'malformed-json') {
        input.raw = Buffer.from('{')
        input.signature = 'sha256=' + createHmac('sha256', secret).update(input.raw).digest('hex')
      }
      expect(() => verifyWebhook(input, secret)).toThrow()
    },
  )
  it('does not treat an unsigned event header as permission to reinterpret the signed body', () => {
    expect(verifyWebhook(signed(payload(), randomUUID(), 'installation'), secret)).toBeNull()
    expect(verifyWebhook(signed({ ...payload(), action: 'completed' }), secret)).toBeNull()
    expect(
      verifyWebhook(
        signed({ ...payload(), workflow_job: { ...payload().workflow_job, labels: ['ubuntu-latest'] } }),
        secret,
      ),
    ).toBeNull()
  })
  it('accepts installation inventory changes without turning them into executable jobs', () => {
    expect(
      ciWakeHint('installation_repositories', {
        action: 'added',
        installation: { id: 9, account: { id: 7 } },
        repositories_added: [{ id: 21 }],
        repositories_removed: [],
      }),
    ).toEqual({ installationId: 9, accountId: 7, repositoryId: 0, job: null })
    expect(() =>
      ciWakeHint('installation_repositories', {
        action: 'added',
        installation: { id: 9, account: { id: 7 } },
        repositories_added: [{ id: -1 }],
        repositories_removed: [],
      }),
    ).toThrow()
  })
})
for (const backend of ['sqlite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.DB_HOST ? describe.skip : describe
  suite(`CI shared webhook inbox ${backend}`, () => {
    let db: StateDatabase,
      sqlite: SqliteStateDatabase | undefined,
      pg: DataSource | undefined,
      state: ListenerState,
      inbox: ListenerInbox,
      directory: string | undefined,
      schema: string
    beforeEach(async () => {
      if (backend === 'sqlite') {
        directory = mkdtempSync(join(tmpdir(), 'ci-inbox-'))
        sqlite = new SqliteStateDatabase(directory)
        db = sqlite
      } else {
        if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
          throw new Error('Disposable local PostgreSQL required')
        schema = 'ci_inbox_' + randomUUID().replaceAll('-', '')
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
      state = new ListenerState(db, 'app:' + randomUUID())
      await state.initialize()
      inbox = new ListenerInbox(state)
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
    const records = async () => state.recover((await state.acquire(randomUUID(), 10000))!)
    it('atomically records a verified delivery, wake and job without holding execution ownership', async () => {
      const notification = verifyWebhook(signed(), secret)!
      expect(await inbox.receive(notification)).toBe('stored')
      const rows = await records()
      expect(rows.map((row) => row.key).sort()).toEqual(
        [`receipt/${notification.delivery}`, 'wake/9/21', 'notice/9/55'].sort(),
      )
      expect(rows.find((row) => row.key === 'notice/9/55')!.payload).toEqual(notification.hint)
      expect(JSON.stringify(rows)).not.toContain(secret.toString('hex'))
    })
    it('deduplicates concurrent receiver instances and rejects a reused delivery with another body', async () => {
      const input = signed(),
        notification = verifyWebhook(input, secret)!
      const results = await Promise.all([inbox.receive(notification), new ListenerInbox(state).receive(notification)])
      expect(results.sort()).toEqual(['duplicate', 'stored'])
      await expect(
        inbox.receive(
          verifyWebhook(
            signed({ ...payload(), workflow_job: { ...payload().workflow_job, id: 56 } }, input.delivery),
            secret,
          )!,
        ),
      ).rejects.toMatchObject({ status: 409 })
      expect((await records()).filter((row) => row.key.startsWith('notice/'))).toHaveLength(1)
    })
    it('leaves all records unchanged when a new delivery conflicts with the original job run', async () => {
      await inbox.receive(verifyWebhook(signed(), secret)!)
      const before = await state.read(['notice/9/55', 'wake/9/21'])
      const conflict = verifyWebhook(
        signed({ ...payload(), workflow_job: { ...payload().workflow_job, run_id: 34 } }),
        secret,
      )!
      await expect(inbox.receive(conflict)).rejects.toMatchObject({ status: 409 })
      expect(await state.read(['notice/9/55', 'wake/9/21'])).toEqual(before)
      expect(await state.read([`receipt/${conflict.delivery}`])).toEqual([])
    })
    it('keeps a newer notice and wake when an older captured version tries to settle', async () => {
      await inbox.receive(verifyWebhook(signed(), secret)!)
      const captured = await state.read(['notice/9/55', 'wake/9/21'])
      await inbox.receive(verifyWebhook(signed(), secret)!)
      const lease = (await state.acquire(randomUUID(), 10000))!
      await expect(
        state.commit(
          lease,
          captured.map((row) => ({ key: row.key, expected: row.version })),
        ),
      ).rejects.toBeInstanceOf(StateConflict)
      expect((await state.read(['notice/9/55', 'wake/9/21'])).map((row) => row.version)).not.toEqual(
        captured.map((row) => row.version),
      )
    })
    it('rejects an unsupported internal event before recording it', async () => {
      const notification = verifyWebhook(signed(), secret)!
      await expect(inbox.receive({ ...notification, event: 'unknown' })).rejects.toMatchObject({ status: 400 })
      expect(await records()).toEqual([])
    })
    it('captures mutable caller input before awaiting storage', async () => {
      const notification = verifyWebhook(signed(), secret)!
      const pending = inbox.receive(notification)
      notification.hint.job!.runId = 999
      await pending
      expect((await state.read(['notice/9/55']))[0].payload).toMatchObject({ job: { id: 55, runId: 33 } })
    })
  })
}
