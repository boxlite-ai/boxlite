import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { baseDataSourceOptions } from '../data-source'
import { AddBoxUsagePeriods1785250000000 } from './1785250000000-add-box-usage-periods-migration'
import { AddAdminUsageWindowIndexes1792470000000 } from './1792470000000-add-admin-usage-window-indexes-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const tables = ['box_usage_periods', 'box_usage_periods_archive'] as const
const indexNames = ['idx_usage_live_end_start', 'idx_usage_archive_end_start']

describeIfDatabase('Admin usage index migration (real PostgreSQL)', () => {
  let db: DataSource
  let schema: string
  const migration = new AddAdminUsageWindowIndexes1792470000000()
  const insert = (table: (typeof tables)[number]) =>
    `INSERT INTO ${table} ("boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region)
     VALUES ('index-fixture','organization','2026-01-01','2026-01-02',1,0,1,1,'region') RETURNING id`
  const indexes = () =>
    db.query(
      `SELECT c.relname AS name, i.indisvalid AS valid, i.indexrelid::text AS oid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2) ORDER BY c.relname`,
      [schema, indexNames],
    )

  beforeEach(async () => {
    schema = `usage_index_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      ssl: false,
      schema,
      entities: [],
      logging: false,
      extra: { options: `-c search_path=${schema},public`, application_name: schema },
      migrationsTransactionMode: baseDataSourceOptions.migrationsTransactionMode,
      migrations: [AddAdminUsageWindowIndexes1792470000000],
    }).initialize()
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    await db.query(`CREATE SCHEMA "${schema}"`)
    const runner = db.createQueryRunner()
    try {
      await new AddBoxUsagePeriods1785250000000().up(runner)
    } finally {
      await runner.release()
    }
  })

  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it.each(tables)('keeps %s writable while an index build waits, then reverts and reapplies', async (table) => {
    const blocker = db.createQueryRunner()
    const writer = db.createQueryRunner()
    let build: Promise<unknown> | undefined
    let buildFinished = false
    try {
      await blocker.startTransaction()
      await blocker.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`)
      build = db.runMigrations().then(
        () => {
          buildFinished = true
        },
        (error: unknown) => {
          buildFinished = true
          return error
        },
      )
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline && !buildFinished) {
        const [state] = await db.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'CREATE INDEX%') AS waiting`,
          [schema],
        )
        if (state.waiting) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await writer.query("SET lock_timeout = '250ms'")
      // A pending ordinary CREATE INDEX queues this writer behind its SHARE lock.
      await expect(writer.query(insert(table))).resolves.toEqual([{ id: expect.any(String) }])
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction()
      await blocker.release()
      await writer.query('RESET lock_timeout')
      await writer.release()
      await build
    }
    await expect(build).resolves.toBeUndefined()
    expect(await indexes()).toEqual(
      [...indexNames].sort().map((name) => ({ name, valid: true, oid: expect.any(String) })),
    )
    await db.undoLastMigration({ transaction: 'none' })
    expect(await indexes()).toEqual([])
    expect(await db.query('SELECT name FROM migrations')).toEqual([])
    await db.runMigrations()
    expect(await indexes()).toHaveLength(2)
  })

  it('retries a partial build, repairing an invalid index without rebuilding its valid sibling', async () => {
    await db.query('CREATE INDEX idx_usage_live_end_start ON box_usage_periods ("endAt", "startAt")')
    const [validIndex] = await indexes()
    const blocker = db.createQueryRunner()
    const builder = db.createQueryRunner()
    try {
      await blocker.startTransaction()
      await blocker.query(insert('box_usage_periods_archive'))
      await builder.query("SET statement_timeout = '250ms'")
      await expect(
        builder.query(`CREATE INDEX CONCURRENTLY idx_usage_archive_end_start
          ON box_usage_periods_archive ("endAt", "startAt")`),
      ).rejects.toMatchObject({ driverError: { code: '57014' } })
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction()
      await blocker.release()
      await builder.query('RESET statement_timeout')
      await builder.release()
    }
    expect(await indexes()).toContainEqual({ name: indexNames[1], valid: false, oid: expect.any(String) })
    await expect(db.runMigrations()).resolves.toHaveLength(1)
    expect(await indexes()).toEqual([{ name: indexNames[1], valid: true, oid: expect.any(String) }, validIndex])
    const runner = db.createQueryRunner()
    try {
      await migration.up(runner)
      await migration.down(runner)
      await migration.down(runner)
      expect(await indexes()).toEqual([])
    } finally {
      await runner.release()
    }
  })
})
