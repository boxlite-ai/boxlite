import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AuditLog } from '../../audit/entities/audit-log.entity'
import { AddPendingAuditIndex1794196800000 } from './1794196800000-add-pending-audit-index-migration'
import { RemoveToolboxUrl1794196800001 } from '../post-deploy/1794196800001-remove-toolbox-url-migration'

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
    await db.query(
      'CREATE INDEX idx_audit_log_pending_created_at ON audit_log ("createdAt") WHERE "statusCode" IS NULL',
    )
    // Catalog fault injection reproduces the state left by an interrupted concurrent build.
    await db.query(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_audit_log_pending_created_at'::regclass",
    )
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
  })

  it('removes only the retired region column and restores its nullable structure', async () => {
    await db.query('CREATE TABLE region (id text PRIMARY KEY, "proxyUrl" text, "toolboxProxyUrl" character varying)')
    await db.query("INSERT INTO region VALUES ('region', 'https://proxy.test', 'https://old.test')")
    const runner = db.createQueryRunner()
    try {
      const removal = new RemoveToolboxUrl1794196800001()
      await removal.up(runner)
      expect(await runner.query('SELECT * FROM region')).toEqual([{ id: 'region', proxyUrl: 'https://proxy.test' }])
      await removal.down(runner)
      expect(await runner.query('SELECT "toolboxProxyUrl" FROM region')).toEqual([{ toolboxProxyUrl: null }])
    } finally {
      await runner.release()
    }
  })
})
