// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm'
import cliDataSource, { baseDataSourceOptions } from './data-source'

class BuildMigrationProbeIndex1796096800000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner) {
    await runner.query('CREATE INDEX CONCURRENTLY migration_probe_index ON migration_probe (id)')
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP INDEX CONCURRENTLY migration_probe_index')
  }
}

async function waitForActivity(observer: DataSource, name: string, patterns: string[]) {
  const deadline = performance.now() + 5_000
  while (performance.now() < deadline) {
    const [activity] = await observer.query(
      'SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND query LIKE ANY($2::text[])',
      [name, patterns],
    )
    if (activity) return
    await setTimeout(20)
  }
  throw new Error(`Did not observe expected activity from ${name}`)
}

const databaseTest = process.env.DB_HOST ? it : it.skip

databaseTest.each([
  {
    fault: 'stalled acquisition',
    functionName: 'pg_try_advisory_lock',
    body: 'PERFORM pg_catalog.pg_advisory_lock($1); PERFORM pg_catalog.pg_sleep(6); RETURN true;',
    error: /timeout|canceling statement/i,
  },
  {
    fault: 'failed unlock',
    functionName: 'pg_advisory_unlock',
    body: "RAISE EXCEPTION 'test unlock failure';",
    error: /test unlock failure/,
  },
])(
  'discards the PostgreSQL session after $fault',
  async ({ functionName, body, error }) => {
    const schema = `migration_fault_${randomUUID().replaceAll('-', '')}`
    const observer = await new DataSource({ ...baseDataSourceOptions, entities: [] }).initialize()
    const MigrationSource = cliDataSource.constructor as typeof DataSource
    const source = new MigrationSource({
      ...baseDataSourceOptions,
      schema,
      entities: [],
      migrations: [],
      extra: { max: 1, options: `-c search_path=${schema},pg_catalog,public` },
    })
    const contender = observer.createQueryRunner()

    try {
      await observer.query(`CREATE SCHEMA "${schema}"`)
      await observer.query(`CREATE FUNCTION "${schema}".${functionName}(bigint) RETURNS boolean
      LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$`)
      await source.initialize()
      const [{ pid }] = await source.query('SELECT pg_backend_pid() AS pid')
      const started = performance.now()
      await expect(source.showMigrations()).rejects.toThrow(error)
      expect(performance.now() - started).toBeLessThan(5_800)
      const [{ pid: replacement }] = await source.query('SELECT pg_backend_pid() AS pid')
      expect(replacement).not.toBe(pid)

      // Keep the original pool open while a competing client acquires the shared key.
      const deadline = performance.now() + 2_000
      let acquired = false
      while (!acquired && performance.now() < deadline) {
        const [result] = await contender.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [
          'boxlite:typeorm:migrations',
        ])
        acquired = result.acquired
        if (!acquired) await setTimeout(20)
      }
      expect(acquired).toBe(true)
    } finally {
      await contender.query('SELECT pg_advisory_unlock_all()').finally(() => contender.release())
      if (source.isInitialized) await source.destroy()
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await observer.destroy()
    }
  },
  15_000,
)

databaseTest(
  'startup and the CLI serialize migrations through a concurrent index build',
  async () => {
    const schema = `migration_lock_${randomUUID().replaceAll('-', '')}`
    const observer = await new DataSource({ ...baseDataSourceOptions, entities: [] }).initialize()
    const MigrationSource = cliDataSource.constructor as typeof DataSource
    const options = {
      ...baseDataSourceOptions,
      schema,
      entities: [],
      migrations: [BuildMigrationProbeIndex1796096800000],
      extra: { max: 1, options: `-c search_path=${schema},public -c statement_timeout=10000` },
    }
    const startupName = `${schema}_startup`
    const cliName = `${schema}_cli`
    const startup = new MigrationSource({ ...options, applicationName: startupName, migrationsRun: true })
    const cli = new MigrationSource({ ...options, applicationName: cliName })
    const writer = observer.createQueryRunner()
    const migrations: Promise<unknown>[] = []

    try {
      await observer.query(`CREATE SCHEMA "${schema}"`)
      await observer.query(`CREATE TABLE "${schema}".migration_probe (id integer)`)
      await writer.startTransaction()
      await writer.query(`INSERT INTO "${schema}".migration_probe VALUES (1)`)

      const start = startup.initialize()
      migrations.push(start)
      void start.catch(() => undefined)
      await waitForActivity(observer, startupName, ['CREATE INDEX CONCURRENTLY%'])

      await cli.initialize()
      const apply = cli.runMigrations()
      migrations.push(apply)
      void apply.catch(() => undefined)
      await waitForActivity(observer, cliName, ['%pg_try_advisory_lock%', 'CREATE INDEX CONCURRENTLY%'])

      await writer.commitTransaction()
      await expect(Promise.all([start, apply]).then(([, applied]) => applied)).resolves.toEqual([])
      expect(await observer.query(`SELECT name FROM "${schema}".migrations`)).toEqual([
        { name: 'BuildMigrationProbeIndex1796096800000' },
      ])
      expect(
        await observer.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [
          `${schema}.migration_probe_index`,
        ]),
      ).toEqual([{ indisvalid: true }])
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction()
      await writer.release()
      await Promise.allSettled(migrations)
      if (startup.isInitialized) await startup.destroy()
      if (cli.isInitialized) await cli.destroy()
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await observer.destroy()
    }
  },
  20_000,
)
