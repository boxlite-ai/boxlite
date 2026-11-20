import { DataSource, type QueryRunner } from 'typeorm'
import { RaisePlatformDomainLimit1794528005000 } from './1794528005000-raise-platform-domain-limit-migration'

describe('RaisePlatformDomainLimit1794528005000', () => {
  const migration = new RaisePlatformDomainLimit1794528005000()

  it('sets the default to 20 and upgrades only organizations at the previous default', async () => {
    const query = jest.fn()
    await migration.up({ query } as unknown as QueryRunner)
    expect(query.mock.calls).toEqual([
      ['ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 20'],
      ['UPDATE "organization" SET "domain_count_limit" = 20 WHERE "domain_count_limit" = 1'],
    ])
  })

  it('restores the old default while preserving allowances already in use', async () => {
    const query = jest.fn()
    await migration.down({ query } as unknown as QueryRunner)
    expect(query.mock.calls).toEqual([['ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 1']])
  })
})

const testWithDatabase = process.env.DB_HOST ? it : it.skip

testWithDatabase('migrates existing and new organization allowances in PostgreSQL', async () => {
  const database = await new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  }).initialize()
  try {
    await database.transaction(async (manager) => {
      const runner = manager.queryRunner!
      const migration = new RaisePlatformDomainLimit1794528005000()
      // PostgreSQL resolves the temporary table before any persistent organization table.
      await runner.query(
        'CREATE TEMP TABLE "organization" (id integer PRIMARY KEY, "domain_count_limit" integer NOT NULL DEFAULT 1) ON COMMIT DROP',
      )
      await runner.query('INSERT INTO "organization" (id, "domain_count_limit") VALUES (1, 1), (2, 0), (3, 50)')
      await migration.up(runner)
      await runner.query('INSERT INTO "organization" (id) VALUES (4)')
      await migration.down(runner)
      await runner.query('INSERT INTO "organization" (id) VALUES (5)')

      const rows: { domain_count_limit: number }[] = await runner.query(
        'SELECT "domain_count_limit" FROM "organization" ORDER BY id',
      )
      expect(rows.map(({ domain_count_limit }) => domain_count_limit)).toEqual([20, 0, 50, 20, 1])
    })
  } finally {
    await database.destroy()
  }
})
