import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddOrganizationReferral1789500000000 } from '../pre-deploy/1789500000000-add-organization-referral-migration'
import { DropOrganizationReferralCode1789600000000 } from './1789600000000-drop-organization-referral-code-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `drop_organization_referral_${process.pid}_${randomUUID().replaceAll('-', '')}`

describe('DropOrganizationReferralCode1789600000000', () => {
  it('drops the constraint and column only where they still exist', async () => {
    const query = jest.fn().mockResolvedValue(undefined)

    await new DropOrganizationReferralCode1789600000000().up({ query } as unknown as QueryRunner)

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('DROP CONSTRAINT IF EXISTS "organization_referral_code_uq"')
    expect(query.mock.calls[0][0]).toContain('DROP COLUMN IF EXISTS "referralCode"')
  })
})

describeIfDatabase('DropOrganizationReferralCode1789600000000 (integration, real Postgres)', () => {
  let dataSource: DataSource

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [],
      synchronize: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  const referralColumns = (queryRunner: QueryRunner) =>
    queryRunner.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'organization' AND column_name = 'referralCode'`,
      [schemaName],
    )

  const referralConstraints = (queryRunner: QueryRunner) =>
    queryRunner.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = 'organization' AND constraint_name = 'organization_referral_code_uq'`,
      [schemaName],
    )

  it('contracts the #1573 expansion and hands a rollback back to it', async () => {
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      await queryRunner.query(`CREATE TABLE "organization" ("id" uuid PRIMARY KEY)`)
      await queryRunner.query(`INSERT INTO "organization" ("id") VALUES ($1)`, [randomUUID()])

      const expand = new AddOrganizationReferral1789500000000()
      const contract = new DropOrganizationReferralCode1789600000000()

      // A database that ran the #1573 pre-deploy migration loses the column and
      // its constraint while its rows survive.
      await expand.up(queryRunner)
      await contract.up(queryRunner)
      expect(await referralColumns(queryRunner)).toEqual([])
      expect(await referralConstraints(queryRunner)).toEqual([])
      expect(await queryRunner.query(`SELECT count(*)::int AS count FROM "organization"`)).toEqual([{ count: 1 }])

      // A database that never had the column, or a re-run, still succeeds.
      await contract.up(queryRunner)
      expect(await referralColumns(queryRunner)).toEqual([])

      // Rolling back restores the expanded shape, uniqueness included ...
      await contract.down(queryRunner)
      expect(await referralColumns(queryRunner)).toEqual([{ column_name: 'referralCode' }])
      await queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'ABCD2345EF')`, [
        randomUUID(),
      ])
      await expect(
        queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'ABCD2345EF')`, [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'organization_referral_code_uq' })

      // ... so the expansion's own unguarded down can run next in a revert chain.
      await expand.down(queryRunner)
      expect(await referralColumns(queryRunner)).toEqual([])
    } finally {
      await queryRunner.release()
    }
  })
})
