import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AuditLog } from './entities/audit-log.entity'
import { AuditService } from './services/audit.service'
import { AuditLogSubscriber } from './subscribers/audit-log.subscriber'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip

databaseSuite('audit backfill on PostgreSQL', () => {
  let db: DataSource
  let service: AuditService
  let schema: string

  beforeEach(async () => {
    schema = `audit_test_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [AuditLog],
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    new AuditLogSubscriber(db)
    service = new (AuditService as any)(
      db.getRepository(AuditLog),
      { get: () => false },
      { acquireLease: async () => ({ signal: new AbortController().signal, release: async () => undefined }) },
    )
  })

  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it.each([2100, 2500])(
    'drains %i rows in one run and is safe to replay',
    async (count) => {
      await db.query(
        `INSERT INTO audit_log (id, "actorId", "actorEmail", action, "createdAt")
      SELECT md5(n::text)::uuid, 'actor', '', 'create', now() - interval '1 hour'
      FROM generate_series(1, $1::int) n`,
        [count],
      )
      await service.resolveDanglingLogs()
      expect(await db.query('SELECT count(*)::int AS pending FROM audit_log WHERE "statusCode" IS NULL')).toEqual([
        { pending: 0 },
      ])
      await service.resolveDanglingLogs()
      expect(await db.query('SELECT count(*)::int AS pending FROM audit_log WHERE "statusCode" IS NULL')).toEqual([
        { pending: 0 },
      ])
    },
    30000,
  )

  it('skips a full batch of live leases and still recovers expired and unleased rows', async () => {
    await db.query(`INSERT INTO audit_log (id, "actorId", "actorEmail", action, "createdAt", "leaseExpiresAt")
      SELECT md5(n::text)::uuid, 'actor', '', 'upload_files', now() - interval '2 hours',
      now() + interval '5 minutes' FROM generate_series(1, 501) n`)
    await db.query(`INSERT INTO audit_log (id, "actorId", "actorEmail", action, "createdAt", "leaseExpiresAt")
      VALUES (md5('expired')::uuid, 'actor', '', 'upload_files', now() - interval '1 hour', now() - interval '1 second'),
      (md5('unleased')::uuid, 'actor', '', 'create', now() - interval '1 hour', NULL)`)
    await service.resolveDanglingLogs()
    expect(
      await db.query(
        'SELECT "statusCode", count(*)::int AS count FROM audit_log GROUP BY "statusCode" ORDER BY "statusCode"',
      ),
    ).toEqual([
      { statusCode: 0, count: 2 },
      { statusCode: null, count: 501 },
    ])
  })

  it('preserves recent pending and finalized rows, and persists explicit unknown status', async () => {
    const repo = db.getRepository(AuditLog)
    const recent = new AuditLog({ actorId: 'actor', actorEmail: '', action: 'create' })
    const complete = new AuditLog({
      actorId: 'actor',
      actorEmail: '',
      action: 'create',
      statusCode: 204,
      createdAt: new Date(Date.now() - 3600000),
    })
    await repo.insert([recent, complete])
    await service.resolveDanglingLogs()
    expect((await repo.findOneByOrFail({ id: recent.id })).statusCode).toBeNull()
    expect((await repo.findOneByOrFail({ id: complete.id })).statusCode).toBe(204)
    await service.updateLog(recent.id, { statusCode: 0 })
    expect((await repo.findOneByOrFail({ id: recent.id })).statusCode).toBe(0)
    await expect(service.updateLog(complete.id, { statusCode: 0 })).rejects.toThrow('immutable')
  })

  it('skips a concurrently completing row and preserves its committed result on replay', async () => {
    const repo = db.getRepository(AuditLog)
    const locked = new AuditLog({
      actorId: 'actor',
      actorEmail: '',
      action: 'create',
      createdAt: new Date(Date.now() - 3600000),
    })
    const other = new AuditLog({ actorId: 'actor', actorEmail: '', action: 'create', createdAt: locked.createdAt })
    await repo.insert([locked, other])
    const writer = db.createQueryRunner()
    await writer.startTransaction()
    let work: Promise<unknown> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await writer.query('UPDATE audit_log SET "statusCode" = 201 WHERE id = $1', [locked.id])
      work = service.resolveDanglingLogs()
      await Promise.race([
        work,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('backfill waited for a locked row')), 2000)
        }),
      ])
      expect((await repo.findOneByOrFail({ id: other.id })).statusCode).toBe(0)
      await writer.commitTransaction()
      await service.resolveDanglingLogs()
      expect((await repo.findOneByOrFail({ id: locked.id })).statusCode).toBe(201)
    } finally {
      clearTimeout(timeout)
      if (writer.isTransactionActive) await writer.rollbackTransaction()
      await writer.release()
      await work
    }
  })
})
