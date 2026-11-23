import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AuditLog } from '../../audit/entities/audit-log.entity'
import { AddPendingAuditIndex1794196800000 } from './1794196800000-add-pending-audit-index-migration'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip
databaseSuite('audit refinement migrations', () => {
  let db: DataSource
  let schema: string
  const migration = new AddPendingAuditIndex1794196800000()
  beforeEach(async () => {
    schema = `audit_index_${randomUUID().replaceAll('-', '')}`
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
      extra: { options: `-c search_path=${schema},public`, application_name: schema },
      migrations: [AddPendingAuditIndex1794196800000],
      migrationsTransactionMode: 'each',
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    await db.query('DROP INDEX idx_audit_log_pending_created_at')
  })
  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('uses a partial index for a sparse backlog and preserves its valid build on retry', async () => {
    await db.query(`INSERT INTO audit_log (id, "actorId", "actorEmail", action, "statusCode", "createdAt")
      SELECT md5(n::text)::uuid, 'actor', '', 'create', CASE WHEN n > 200000 THEN NULL ELSE 204 END,
      now() - interval '1 hour' FROM generate_series(1, 200100) n`)
    await db.query('ANALYZE audit_log')
    const query = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM audit_log
      WHERE "statusCode" IS NULL AND "createdAt" < $1 ORDER BY "createdAt" LIMIT 500 FOR UPDATE SKIP LOCKED`
    const cutoff = new Date(Date.now() - 1800000)
    const before = (await db.query(query, [cutoff]))[0]['QUERY PLAN'][0]
    await db.runMigrations()
    const runner = db.createQueryRunner()
    try {
      const oid = (await runner.query("SELECT 'idx_audit_log_pending_created_at'::regclass::oid AS oid"))[0].oid
      await migration.up(runner)
      expect((await runner.query("SELECT 'idx_audit_log_pending_created_at'::regclass::oid AS oid"))[0].oid).toBe(oid)
      const after = (await db.query(query, [cutoff]))[0]['QUERY PLAN'][0]
      expect(JSON.stringify(after.Plan)).toContain('idx_audit_log_pending_created_at')
      expect(after.Plan['Shared Hit Blocks']).toBeLessThan(before.Plan['Shared Hit Blocks'])
      console.log('AUDIT_INDEX_PLAN', JSON.stringify({ before, after }))
      await migration.down(runner)
      await migration.up(runner)
    } finally {
      await runner.release()
    }
  }, 30000)

  it('repairs an invalid concurrent build and refuses an unrelated same-name index', async () => {
    const snapshot = db.createQueryRunner()
    const builder = db.createQueryRunner()
    let build: Promise<unknown> | undefined
    try {
      await snapshot.startTransaction('REPEATABLE READ')
      await snapshot.query('SELECT * FROM audit_log')
      const [{ pid }] = await builder.query('SELECT pg_backend_pid() AS pid')
      await builder.query("SET statement_timeout = '10s'")
      build = builder.query(
        'CREATE INDEX CONCURRENTLY idx_audit_log_pending_created_at ON audit_log ("createdAt") WHERE "statusCode" IS NULL',
      )
      void build.catch(() => undefined)
      const deadline = Date.now() + 5000
      let phase: string | undefined
      while (Date.now() < deadline) {
        phase = (await db.query('SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1', [pid]))[0]?.phase
        if (phase === 'waiting for old snapshots') break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(phase).toBe('waiting for old snapshots')
      await db.query('SELECT pg_cancel_backend($1)', [pid])
      await expect(build).rejects.toMatchObject({ code: '57014' })
    } finally {
      if (snapshot.isTransactionActive) await snapshot.rollbackTransaction()
      await build?.catch(() => undefined)
      await builder.query('RESET statement_timeout')
      await builder.release()
      await snapshot.release()
    }
    expect(
      (
        await db.query(
          "SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_audit_log_pending_created_at'::regclass",
        )
      )[0].indisvalid,
    ).toBe(false)
    const runner = db.createQueryRunner()
    try {
      await migration.up(runner)
      expect(
        (
          await runner.query(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_audit_log_pending_created_at'::regclass",
          )
        )[0].indisvalid,
      ).toBe(true)
      await migration.down(runner)
      await runner.query('CREATE INDEX idx_audit_log_pending_created_at ON audit_log ("actorId")')
      await expect(migration.up(runner)).rejects.toThrow('unexpected definition')
    } finally {
      await runner.release()
    }
  }, 15000)
})
