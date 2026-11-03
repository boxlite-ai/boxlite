/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Migration1741087887225 } from '../1741087887225-migration'
import { AddMemoryCheckpoints1793600000000 } from './1793600000000-add-memory-checkpoints-migration'

const databaseTests = process.env.DB_HOST ? describe : describe.skip

databaseTests('Memory checkpoint actual migration', () => {
  let admin: DataSource, source: DataSource
  const name = `checkpoint_migration_${randomUUID().replaceAll('-', '')}`
  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  }
  beforeAll(async () => {
    admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    await admin.query(`CREATE DATABASE "${name}"`)
    source = await new DataSource({ ...connection, database: name, migrations: [Migration1741087887225] }).initialize()
    await source.runMigrations()
  })
  afterAll(async () => {
    if (source?.isInitialized) await source.destroy()
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.destroy()
    }
  })
  it('upgrades the existing schema, enforces checkpoint names and rolls back without removing enum values', async () => {
    const runner = source.createQueryRunner(),
      migration = new AddMemoryCheckpoints1793600000000()
    await runner.connect()
    try {
      await runner.startTransaction()
      await migration.up(runner)
      await runner.commitTransaction()
      expect(
        (await source.query(`SELECT enum_range(NULL::public.box_state_enum)::text AS states`))[0].states,
      ).toContain('paused')
      expect(
        (
          await source.query(
            `SELECT column_default FROM information_schema.columns WHERE table_name='runner' AND column_name='checkpointsEnabled'`,
          )
        )[0].column_default,
      ).toBe('false')
      const id = randomUUID(),
        org = randomUUID()
      await source.query(
        `INSERT INTO box_checkpoint (id,"organizationId",name,"sourceBoxId",region,configuration,cpus,"memoryMib","diskGb") VALUES ($1,$2,'reserved','deleted-source','test','{}',1,1024,1)`,
        [id, org],
      )
      await expect(
        source.query(
          `INSERT INTO box_checkpoint (id,"organizationId",name,"sourceBoxId",region,configuration,cpus,"memoryMib","diskGb") VALUES ($1,$2,'reserved','source','test','{}',1,1024,1)`,
          [randomUUID(), org],
        ),
      ).rejects.toMatchObject({ code: '23505' })
      await source.query(`UPDATE box_checkpoint SET state='deleting' WHERE id=$1`, [id])
      await source.query(
        `INSERT INTO box_checkpoint (id,"organizationId",name,"sourceBoxId",region,configuration,cpus,"memoryMib","diskGb") VALUES ($1,$2,'reserved','source','test','{}',1,1024,1)`,
        [randomUUID(), org],
      )
      await migration.down(runner)
      expect((await source.query(`SELECT to_regclass('public.box_checkpoint') AS table`))[0].table).toBeNull()
      expect(
        (await source.query(`SELECT enum_range(NULL::public.box_state_enum)::text AS states`))[0].states,
      ).toContain('paused')
      await migration.up(runner)
    } finally {
      await runner.release()
    }
  })
})
