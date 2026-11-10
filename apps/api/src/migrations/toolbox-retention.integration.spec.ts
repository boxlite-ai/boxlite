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
import { DataSource, MigrationInterface } from 'typeorm'
import { AppModule } from '../app.module'
import { AuditLog } from '../audit/entities/audit-log.entity'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip
databaseSuite('Toolbox column during rolling API deployment', () => {
  let db: DataSource
  let schema: string
  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('keeps the old Region query and value after all pending startup migrations', async () => {
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
      entities: [AuditLog],
      migrations,
      extra: { options: `-c search_path=${schema},public` },
      entitySkipConstructor: true,
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    await db.query('DROP INDEX idx_audit_log_pending_created_at')
    await db.query('CREATE TABLE region (id text PRIMARY KEY, "proxyUrl" text, "toolboxProxyUrl" character varying)')
    await db.query("INSERT INTO region VALUES ('us', 'https://proxy.test', 'https://legacy.test')")
    await db.query('CREATE TABLE migrations (id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)')
    // Model an existing installation: earlier migrations ran before this release.
    for (const migration of db.migrations) {
      const name = migration.name || migration.constructor.name
      const timestamp = Number(name.slice(-13))
      if (timestamp < 1794196800000)
        await db.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [timestamp, name])
    }
    await db.runMigrations()
    expect(await db.query('SELECT id, "toolboxProxyUrl" FROM region')).toEqual([
      { id: 'us', toolboxProxyUrl: 'https://legacy.test' },
    ])
  }, 30000)
})
