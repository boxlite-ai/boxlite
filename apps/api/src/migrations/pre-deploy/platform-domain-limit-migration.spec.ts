import { DataSource, getMetadataArgsStorage, type MigrationInterface } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { RaisePlatformDomainLimit1794528005000 } from './1794528005000-raise-platform-domain-limit-migration'
import { RestorePlatformDomainLimit1795392000000 } from './1795392000000-restore-platform-domain-limit-migration'

const historicalMigration: MigrationInterface = new RaisePlatformDomainLimit1794528005000()
const restoreDefault = new RestorePlatformDomainLimit1795392000000()

it('defaults new organizations to one platform name in the entity', () => {
  const limit = getMetadataArgsStorage().columns.find(
    (column) => column.target === Organization && column.propertyName === 'domainCountLimit',
  )
  expect(limit?.options.default).toBe(1)
})

const testWithDatabase = process.env.DB_HOST ? it : it.skip

testWithDatabase.each([
  { from: 'main', ranRaise: false },
  { from: 'a database with the raised default', ranRaise: true },
])('applies the one-name default from $from and preserves stored allowances', async ({ ranRaise }) => {
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
      await runner.query('SET LOCAL search_path TO pg_temp')
      await runner.query(`
        CREATE TEMP TABLE organization (
          id serial PRIMARY KEY, domain_count_limit integer NOT NULL DEFAULT 1
        ) ON COMMIT DROP
      `)
      await runner.query('INSERT INTO organization (domain_count_limit) VALUES (0), (1), (20), (50)')
      if (ranRaise) {
        await runner.query('ALTER TABLE organization ALTER COLUMN domain_count_limit SET DEFAULT 20')
      } else {
        await historicalMigration.up(runner)
      }
      await runner.query('INSERT INTO organization DEFAULT VALUES')
      await restoreDefault.up(runner)
      await runner.query('INSERT INTO organization DEFAULT VALUES')
      await restoreDefault.down(runner)
      await runner.query('INSERT INTO organization DEFAULT VALUES')
      await historicalMigration.down(runner)
      await runner.query('INSERT INTO organization DEFAULT VALUES')

      const rows: { domain_count_limit: number }[] = await runner.query(
        'SELECT domain_count_limit FROM organization ORDER BY id',
      )
      const limits = rows.map(({ domain_count_limit }) => domain_count_limit)
      expect(limits).toEqual([0, 1, 20, 50, ranRaise ? 20 : 1, 1, 20, 1])
    })
  } finally {
    await database.destroy()
  }
})
