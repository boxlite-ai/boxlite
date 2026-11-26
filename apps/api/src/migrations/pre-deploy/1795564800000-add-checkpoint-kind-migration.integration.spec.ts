// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddCheckpoints1793923200000 } from './1793923200000-add-checkpoints-migration'
import { AddCheckpointKind1795564800000 } from './1795564800000-add-checkpoint-kind-migration'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `checkpoint_kind_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeWithDatabase('checkpoint kind migration (real PostgreSQL)', () => {
  let dataSource: DataSource
  let runner: QueryRunner
  const baseMigration = new AddCheckpoints1793923200000()
  const migration = new AddCheckpointKind1795564800000()

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    runner = dataSource.createQueryRunner()
    await runner.connect()
  })

  beforeEach(async () => {
    await runner.query(`CREATE SCHEMA "${schema}"`)
    await runner.query(`CREATE TYPE "${schema}"."job_resourcetype_enum" AS ENUM ('BOX','ARTIFACT','BACKUP')`)
    await runner.query(`CREATE TABLE "${schema}"."box" ("id" varchar PRIMARY KEY)`)
    await runner.query(
      `CREATE TABLE "${schema}"."job" ("type" varchar, "resourceType" "${schema}"."job_resourcetype_enum", "completedAt" timestamptz)`,
    )
    await baseMigration.up(runner)
  })

  afterEach(async () => {
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  })

  afterAll(async () => {
    await runner?.release()
    await dataSource?.destroy()
  })

  it('backfills existing rows as disk and enforces kind and memorySizeBytes constraints', async () => {
    const existingId = randomUUID()
    await runner.query(
      `INSERT INTO "checkpoint" ("id","organizationId","name","sourceBoxId","sourceRunnerId","sourceState","arcPath","environment")
       VALUES ($1,$2,'legacy','source-1',$3,'stopped','gs://bucket/legacy','{}')`,
      [existingId, randomUUID(), randomUUID()],
    )

    await migration.up(runner)

    const [legacy] = await runner.query(`SELECT "kind", "memorySizeBytes" FROM "checkpoint" WHERE "id" = $1`, [
      existingId,
    ])
    expect(legacy).toEqual({ kind: 'disk', memorySizeBytes: null })

    await expect(
      runner.query(
        `INSERT INTO "checkpoint" ("id","organizationId","name","sourceBoxId","sourceRunnerId","sourceState","kind","arcPath","environment")
         VALUES ($1,$2,'bad-kind','source-2',$3,'started','snapshot','gs://bucket/bad','{}')`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await expect(
      runner.query(
        `INSERT INTO "checkpoint" ("id","organizationId","name","sourceBoxId","sourceRunnerId","sourceState","kind","memorySizeBytes","arcPath","environment")
         VALUES ($1,$2,'neg-mem','source-3',$3,'started','full',-1,'gs://bucket/neg','{}')`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses rollback while full checkpoints exist and drops columns once removed', async () => {
    await migration.up(runner)
    const fullId = randomUUID()
    await runner.query(
      `INSERT INTO "checkpoint" ("id","organizationId","name","sourceBoxId","sourceRunnerId","sourceState","kind","memorySizeBytes","arcPath","environment")
       VALUES ($1,$2,'full-1','source-1',$3,'started','full',4096,'gs://bucket/full','{}')`,
      [fullId, randomUUID(), randomUUID()],
    )

    await expect(migration.down(runner)).rejects.toThrow('Delete full checkpoints')
    expect(await runner.hasColumn('checkpoint', 'kind')).toBe(true)
    expect(await runner.hasColumn('checkpoint', 'memorySizeBytes')).toBe(true)

    await runner.query(`DELETE FROM "checkpoint" WHERE "id" = $1`, [fullId])
    await migration.down(runner)
    expect(await runner.hasColumn('checkpoint', 'kind')).toBe(false)
    expect(await runner.hasColumn('checkpoint', 'memorySizeBytes')).toBe(false)
  })
})
