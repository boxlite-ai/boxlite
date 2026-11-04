import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddBoxSnapshotTables1791200000001 } from './1791200000001-add-box-snapshot-tables-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

describeIfDatabase('snapshot catalog migration (integration, isolated Postgres database)', () => {
  const databaseName = `snapshot_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`
  let admin: DataSource
  let database: DataSource
  let runner: QueryRunner
  let created = false

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [],
      synchronize: false,
    }
    admin = await new DataSource(connection).initialize()
    // This migration explicitly names public enums, so a database isolates them too.
    if (!/^snapshot_migration_[a-z0-9_]+$/.test(databaseName)) throw new Error('Invalid test database name')
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    created = true
    database = await new DataSource({ ...connection, database: databaseName }).initialize()
    runner = database.createQueryRunner()
    await runner.connect()
    await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    await runner.query('CREATE TABLE "box" ("id" character varying(12) PRIMARY KEY)')
  })

  afterAll(async () => {
    await runner?.release()
    if (database?.isInitialized) await database.destroy()
    if (admin?.isInitialized) {
      try {
        if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
      } finally {
        await admin.destroy()
      }
    }
  })

  it('enforces live names, retains source-independent snapshots, cascades restores, and rolls back cleanly', async () => {
    const migration = new AddBoxSnapshotTables1791200000001()
    await migration.up(runner)
    const organizationId = randomUUID()
    const insertSnapshot = () =>
      runner.query(
        `INSERT INTO "box_snapshot" ("organizationId", "name", "sourceBoxId", "region", "diskGb")
       VALUES ($1, 'saved', 'source', 'us', 10) RETURNING "id", "state", "sizeBytes", "archiveUri"`,
        [organizationId],
      )
    await runner.query(`INSERT INTO "box" ("id") VALUES ('source'), ('target')`)
    const [first] = await insertSnapshot()
    expect(first).toMatchObject({ state: 'creating', sizeBytes: '0', archiveUri: '' })
    await expect(insertSnapshot()).rejects.toMatchObject({ code: '23505' })
    await runner.query(`UPDATE "box_snapshot" SET "state" = 'failed' WHERE "id" = $1`, [first.id])
    await expect(insertSnapshot()).rejects.toMatchObject({ code: '23505' })
    await runner.query(`UPDATE "box_snapshot" SET "state" = 'deleting' WHERE "id" = $1`, [first.id])
    const [second] = await insertSnapshot()
    expect(second.id).not.toBe(first.id)
    await runner.query(`DELETE FROM "box" WHERE "id" = 'source'`)
    expect(await runner.query(`SELECT "id" FROM "box_snapshot" ORDER BY "createdAt"`)).toHaveLength(2)

    const insertRestore = (snapshotId: string, boxId = 'target') =>
      runner.query(
        `INSERT INTO "box_snapshot_restore" ("organizationId", "boxId", "snapshotId")
       VALUES ($1, $2, $3) RETURNING "id", "state"`,
        [organizationId, boxId, snapshotId],
      )
    await expect(insertRestore(randomUUID())).rejects.toMatchObject({ code: '23503' })
    await expect(insertRestore(second.id, 'missing')).rejects.toMatchObject({ code: '23503' })
    const [restore] = await insertRestore(second.id)
    expect(restore.state).toBe('pending')
    await runner.query(`DELETE FROM "box_snapshot" WHERE "id" = $1`, [second.id])
    expect(await runner.query('SELECT "id" FROM "box_snapshot_restore"')).toEqual([])
    const [third] = await insertSnapshot()
    await insertRestore(third.id)
    await runner.query(`DELETE FROM "box" WHERE "id" = 'target'`)
    expect(await runner.query('SELECT "id" FROM "box_snapshot_restore"')).toEqual([])
    expect(await runner.query(`SELECT "id" FROM "box_snapshot" WHERE "id" = $1`, [third.id])).toEqual([
      { id: third.id },
    ])

    await migration.down(runner)
    expect(
      await runner.query(
        `SELECT to_regclass('box_snapshot') AS snapshot, to_regclass('box_snapshot_restore') AS restore`,
      ),
    ).toEqual([{ snapshot: null, restore: null }])
    expect(
      await runner.query(
        `SELECT typname FROM pg_type WHERE typname IN ('box_snapshot_state_enum', 'box_snapshot_restore_state_enum')`,
      ),
    ).toEqual([])
    await migration.up(runner)
    await expect(insertSnapshot()).resolves.toHaveLength(1)
    await migration.down(runner)
  })
})
