// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: () => () => undefined,
  fixRequestBody: () => undefined,
}))

import { MODULE_METADATA } from '@nestjs/common/constants'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TYPEORM_MODULE_OPTIONS } from '@nestjs/typeorm/dist/typeorm.constants'
import { randomUUID } from 'node:crypto'
import { globSync } from 'glob'
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm'
import { AppModule } from '../app.module'
import { Region } from '../region/entities/region.entity'
import { Migration1741087887225 } from './1741087887225-migration'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip
databaseSuite('Toolbox column after the compatibility release', () => {
  let db: DataSource
  let schema: string
  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('removes only the retired column through startup discovery and restores only its schema on rollback', async () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as any[]
    const core = imports.find((entry) => entry.module === TypeOrmModule).imports[0]
    const factory = core.providers.find((entry: any) => entry.provide === TYPEORM_MODULE_OPTIONS)
    const options = factory.useFactory({ get: () => undefined, getOrThrow: () => false, getRedisConfig: () => ({}) })
    const migrations = globSync(options.migrations)
      .flatMap((file) => Object.values(require(file)))
      .filter((value): value is new () => MigrationInterface => typeof value === 'function')
    schema = `toolbox_compat_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      ...options,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      cache: false,
      migrationsRun: false,
      entities: [Region],
      migrations,
      extra: { options: `-c search_path=${schema},public` },
      entitySkipConstructor: true,
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    // Use the baseline's emitted Region DDL, isolating its public enum in this test schema.
    const statements: string[] = []
    await new Migration1741087887225().up({
      query: async (sql: string) => {
        statements.push(sql)
      },
    } as QueryRunner)
    for (const sql of statements.filter(
      (sql) =>
        sql.startsWith('CREATE TYPE "public"."region_regiontype_enum"') || sql.startsWith('CREATE TABLE "region"'),
    ))
      await db.query(sql.replaceAll('"public".', `"${schema}".`))
    await db.query(`INSERT INTO region (id, name, "regionType", "proxyUrl", "toolboxProxyUrl")
      VALUES ('us', 'United States', 'shared', 'https://proxy.test', 'https://legacy.test')`)
    await db.query('CREATE TABLE migrations (id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)')
    // Other migrations have already run before the removal release.
    for (const migration of db.migrations) {
      const name = migration.name || migration.constructor.name
      const timestamp = Number(name.slice(-13))
      if (name !== 'RemoveToolboxUrl1794400000000')
        await db.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [timestamp, name])
    }
    await db.runMigrations()
    const columns = () =>
      db.query(
        `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'region' AND column_name = 'toolboxProxyUrl'`,
        [schema],
      )
    expect(await columns()).toEqual([])
    expect(await db.getRepository(Region).findOneBy({ id: 'us' })).toMatchObject({
      id: 'us',
      proxyUrl: 'https://proxy.test',
    })
    expect(await db.runMigrations()).toEqual([])
    await db.undoLastMigration()
    expect(await columns()).toEqual([{ column_name: 'toolboxProxyUrl' }])
    expect(await db.query('SELECT id, "proxyUrl", "toolboxProxyUrl" FROM region')).toEqual([
      { id: 'us', proxyUrl: 'https://proxy.test', toolboxProxyUrl: null },
    ])
    await db.runMigrations()
    expect(await columns()).toEqual([])
  }, 30000)
})
