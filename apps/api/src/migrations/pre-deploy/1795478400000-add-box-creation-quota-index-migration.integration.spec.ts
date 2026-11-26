/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { BOX_CREATION_LIMIT_EXCLUDED_STATES } from '../../box/repositories/box.repository'
import { AddBoxCreationQuotaIndex1795478400000 } from './1795478400000-add-box-creation-quota-index-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const migration = new AddBoxCreationQuotaIndex1795478400000()
const indexName = 'box_creation_quota_idx'
const connectionOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
}

describeIfDatabase('Box creation quota index (integration, real Postgres)', () => {
  let db: DataSource
  let schema: string
  let shadow: string
  let runner: QueryRunner

  async function index() {
    const [entry] = await db.query(
      `SELECT c.oid, i.indisvalid AS valid, am.amname AS method,
        pg_get_indexdef(i.indexrelid, 1, true) AS key,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_class c
      LEFT JOIN pg_index i ON i.indexrelid = c.oid
      LEFT JOIN pg_am am ON am.oid = c.relam
      WHERE c.oid = to_regclass($1)`,
      [`"${schema}".${indexName}`],
    )
    return entry
  }

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '')
    schema = `quota_Migration_${suffix}`
    shadow = `quota_shadow_${suffix}`
    db = await new DataSource({
      ...connectionOptions,
      schema,
      extra: { options: `-c search_path=${shadow},public` },
      migrations: [AddBoxCreationQuotaIndex1795478400000],
      migrationsTransactionMode: 'each',
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(`CREATE SCHEMA "${shadow}"`)
    await db.query(`CREATE TYPE "${schema}".box_state_enum AS ENUM
      ('error', 'destroying', 'destroyed', 'archiving', 'archived', 'started')`)
    await db.query(`CREATE TABLE "${schema}".box (
      "organizationId" uuid NOT NULL, state "${schema}".box_state_enum NOT NULL)`)
    runner = db.createQueryRunner()
  })

  afterEach(async () => {
    if (db?.isInitialized) {
      try {
        await runner?.release()
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await db.query(`DROP SCHEMA IF EXISTS "${shadow}" CASCADE`)
      } finally {
        await db.destroy()
      }
    }
  })

  it('applies, verifies, preserves, and reverts the valid index in the configured schema', async () => {
    await db.query(`CREATE TYPE "${shadow}".box_state_enum AS ENUM ('unrelated')`)
    await db.query(`CREATE TABLE "${shadow}".box (id int)`)
    await db.query(`CREATE INDEX ${indexName} ON "${shadow}".box (id)`)
    const [{ oid: shadowOid }] = await db.query(`SELECT '${indexName}'::regclass::oid AS oid`)
    expect(await index()).toBeUndefined()

    expect(await db.runMigrations()).toHaveLength(1)
    const literals = BOX_CREATION_LIMIT_EXCLUDED_STATES.map((state) => `'${state}'::"${schema}".box_state_enum`)
    const installed = await index()
    expect(installed).toEqual({
      oid: expect.any(Number),
      valid: true,
      method: 'btree',
      key: '"organizationId"',
      predicate: `(state <> ALL (ARRAY[${literals.join(', ')}]))`,
    })
    await migration.up(runner)
    expect(await index()).toEqual(installed)

    await db.undoLastMigration({ transaction: 'none' })
    expect(await index()).toBeUndefined()
    await migration.down(runner)
    expect(await db.query(`SELECT '${indexName}'::regclass::oid AS oid`)).toEqual([{ oid: shadowOid }])
    expect(await db.runMigrations()).toHaveLength(1)
    const rebuilt = await index()
    expect(rebuilt).toEqual({ ...installed, oid: expect.any(Number) })
    expect(rebuilt.oid).not.toBe(installed.oid)
  })

  it('preserves and drops the same index when PostgreSQL quotes all identifiers', async () => {
    await runner.query('SET quote_all_identifiers = on')
    try {
      await migration.up(runner)
      const installed = await index()
      expect(installed).toMatchObject({ oid: expect.any(Number), valid: true })
      await migration.up(runner)
      expect(await index()).toEqual(installed)
      await migration.down(runner)
      expect(await index()).toBeUndefined()
    } finally {
      await runner.query('RESET quote_all_identifiers')
    }
  })

  it('targets the schema of the visible box table when no schema is configured', async () => {
    const connection = await new DataSource(connectionOptions).initialize()
    const session = connection.createQueryRunner()
    try {
      await session.query(`SET search_path TO "${shadow}", "${schema}", public`)
      await migration.up(session)
      expect(await index()).toMatchObject({ method: 'btree', valid: true })
      await migration.down(session)
      expect(await index()).toBeUndefined()
    } finally {
      await session.release()
      await connection.destroy()
    }
  })

  it('retries a matching index left invalid by a canceled concurrent build', async () => {
    const snapshot = db.createQueryRunner()
    let build: Promise<void> | undefined
    try {
      await snapshot.startTransaction('REPEATABLE READ')
      await snapshot.query(`SELECT * FROM "${schema}".box`)
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid')
      await runner.query("SET statement_timeout = '10s'")
      build = migration.up(runner)
      void build.catch(() => undefined)
      const deadline = Date.now() + 5000
      let phase: string | undefined
      while (Date.now() < deadline) {
        phase = (await db.query('SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1', [pid]))[0]?.phase
        if (phase === 'waiting for old snapshots') break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(phase).toBe('waiting for old snapshots')
      expect(await db.query('SELECT pg_cancel_backend($1) AS canceled', [pid])).toEqual([{ canceled: true }])
      await expect(build).rejects.toMatchObject({ code: '57014' })
    } finally {
      if (snapshot.isTransactionActive) await snapshot.rollbackTransaction()
      await snapshot.release()
      await build?.catch(() => undefined)
      await runner.query('RESET statement_timeout')
    }

    const invalid = await index()
    expect(invalid.valid).toBe(false)
    expect(await db.runMigrations()).toHaveLength(1)
    expect(await index()).toEqual({ ...invalid, oid: expect.any(Number), valid: true })
    expect((await index()).oid).not.toBe(invalid.oid)
  }, 15000)

  it.each([
    ['a table', (schema: string) => `CREATE TABLE "${schema}".${indexName} (id int)`],
    [
      'a different key',
      (schema: string) => `CREATE INDEX ${indexName} ON "${schema}".box (state)
        WHERE state NOT IN ('error', 'destroying', 'destroyed', 'archiving', 'archived')`,
    ],
    [
      'a different predicate',
      (schema: string) => `CREATE INDEX ${indexName} ON "${schema}".box ("organizationId") WHERE state <> 'error'`,
    ],
    [
      'a different access method',
      (schema: string) => `CREATE INDEX ${indexName} ON "${schema}".box USING hash ("organizationId")
        WHERE state NOT IN ('error', 'destroying', 'destroyed', 'archiving', 'archived')`,
    ],
  ])('refuses to replace or drop %s with the same name', async (_description, create) => {
    await db.query(create(schema))
    const collision = await index()
    expect(collision.oid).toEqual(expect.any(Number))
    await expect(migration.up(runner)).rejects.toThrow('unexpected definition')
    await expect(migration.down(runner)).rejects.toThrow('unexpected definition')
    expect(await index()).toEqual(collision)
  })
})
