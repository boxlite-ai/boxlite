// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm'
import cliDataSource, { baseDataSourceOptions } from './data-source'

class CreateMigrationProbe1796096799000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query('CREATE TABLE migration_probe (id integer)')
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE migration_probe')
  }
}

class BuildMigrationProbeIndex1796096800000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner) {
    expect(await runner.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '10s' }])
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

databaseTest('reports a committed revert as successful when unlock fails', async () => {
  const schema = `migration_revert_${randomUUID().replaceAll('-', '')}`
  const observer = await new DataSource({ ...baseDataSourceOptions, entities: [] }).initialize()
  const MigrationSource = cliDataSource.constructor as typeof DataSource
  const source = new MigrationSource({
    ...baseDataSourceOptions,
    schema,
    entities: [],
    migrations: [CreateMigrationProbe1796096799000, BuildMigrationProbeIndex1796096800000],
    extra: { max: 1, options: `-c search_path=${schema},pg_catalog,public -c statement_timeout=10000` },
  })

  try {
    await observer.query(`CREATE SCHEMA "${schema}"`)
    await source.initialize()
    await expect(source.runMigrations()).resolves.toHaveLength(2)
    const [{ pid }] = await source.query('SELECT pg_backend_pid() AS pid')
    await observer.query(`CREATE FUNCTION "${schema}".pg_advisory_unlock(bigint) RETURNS boolean
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test unlock failure'; END; $$`)

    const revert = await source.undoLastMigration({ transaction: 'none' }).then(
      () => ({ succeeded: true }),
      (error: Error) => ({ succeeded: false, error: error.message }),
    )
    expect(await observer.query(`SELECT name FROM "${schema}".migrations`)).toEqual([
      { name: 'CreateMigrationProbe1796096799000' },
    ])
    expect(await observer.query('SELECT to_regclass($1)::text AS name', [`${schema}.migration_probe_index`])).toEqual([
      { name: null },
    ])
    expect(revert).toEqual({ succeeded: true })
    const [{ pid: replacement }] = await source.query('SELECT pg_backend_pid() AS pid')
    expect(replacement).not.toBe(pid)

    // The replacement session can enter the lock after cleanup.
    await observer.query(`DROP FUNCTION "${schema}".pg_advisory_unlock(bigint)`)
    await expect(source.showMigrations()).resolves.toBe(true)
  } finally {
    if (source.isInitialized) await source.destroy()
    await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await observer.destroy()
  }
})

databaseTest.each([
  {
    bound: 'server',
    statementTimeout: 20_000,
    error: /statement timeout|Query read timeout/i,
  },
  {
    bound: 'client',
    statementTimeout: 0,
    error: /Query read timeout/,
  },
])(
  'bounds stalled acquisition on the $bound and discards the session',
  async ({ bound, statementTimeout, error }) => {
    const schema = `migration_fault_${randomUUID().replaceAll('-', '')}`
    const observer = await new DataSource({ ...baseDataSourceOptions, entities: [] }).initialize()
    const MigrationSource = cliDataSource.constructor as typeof DataSource
    const source = new MigrationSource({
      ...baseDataSourceOptions,
      schema,
      entities: [],
      migrations: [],
      extra: { max: 1, options: `-c search_path=${schema},pg_catalog,public -c statement_timeout=${statementTimeout}` },
    })
    const contender = observer.createQueryRunner()

    try {
      await observer.query(`CREATE SCHEMA "${schema}"`)
      await observer.query(`CREATE FUNCTION "${schema}".pg_try_advisory_lock(bigint) RETURNS boolean
        LANGUAGE plpgsql AS $$ BEGIN
          PERFORM pg_catalog.pg_advisory_lock($1);
          PERFORM pg_catalog.pg_sleep(12);
          RETURN true;
        END; $$`)
      if (bound === 'client') {
        // Suppress the server deadline so only the driver can report the timeout.
        await observer.query(`CREATE FUNCTION "${schema}".set_config(text, text, boolean) RETURNS text
          LANGUAGE sql AS $$ SELECT $2 $$`)
      }
      await source.initialize()
      const [{ pid }] = await source.query('SELECT pg_backend_pid() AS pid')
      const started = performance.now()
      await expect(source.showMigrations()).rejects.toThrow(error)
      expect(performance.now() - started).toBeLessThan(5_800)
      const [{ pid: replacement }] = await source.query('SELECT pg_backend_pid() AS pid')
      expect(replacement).not.toBe(pid)

      if (bound === 'client') {
        // PostgreSQL can keep running a statement after the client drops its socket.
        expect(await observer.query('SELECT pg_cancel_backend($1) AS canceled', [pid])).toEqual([{ canceled: true }])
      }

      // The original server statement would still be asleep without the server timeout.
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
  'two API startups and the CLI serialize a concurrent index migration',
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
    const replicaName = `${schema}_replica`
    const cliName = `${schema}_cli`
    const startup = new MigrationSource({ ...options, applicationName: startupName, migrationsRun: true })
    const replica = new MigrationSource({ ...options, applicationName: replicaName, migrationsRun: true })
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

      const startReplica = replica.initialize()
      migrations.push(startReplica)
      void startReplica.catch(() => undefined)
      await waitForActivity(observer, replicaName, ['%pg_try_advisory_lock%', 'CREATE INDEX CONCURRENTLY%'])

      await cli.initialize()
      const apply = cli.runMigrations()
      migrations.push(apply)
      void apply.catch(() => undefined)
      await waitForActivity(observer, cliName, ['%pg_try_advisory_lock%', 'CREATE INDEX CONCURRENTLY%'])

      await writer.commitTransaction()
      await expect(Promise.all([start, startReplica, apply]).then(([, , applied]) => applied)).resolves.toEqual([])
      expect(await observer.query(`SELECT name FROM "${schema}".migrations`)).toEqual([
        { name: 'BuildMigrationProbeIndex1796096800000' },
      ])
      expect(
        await observer.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [
          `${schema}.migration_probe_index`,
        ]),
      ).toEqual([{ indisvalid: true }])
      await expect(cli.showMigrations()).resolves.toBe(false)
      await cli.undoLastMigration({ transaction: 'none' })
      expect(await observer.query(`SELECT name FROM "${schema}".migrations`)).toEqual([])
      await expect(cli.showMigrations()).resolves.toBe(true)
      await expect(cli.runMigrations()).resolves.toHaveLength(1)
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction()
      await writer.release()
      await Promise.allSettled(migrations)
      if (startup.isInitialized) await startup.destroy()
      if (replica.isInitialized) await replica.destroy()
      if (cli.isInitialized) await cli.destroy()
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await observer.destroy()
    }
  },
  20_000,
)
