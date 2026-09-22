import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationInvitation } from '../../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../../organization/entities/organization-role.entity'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { AddOrganizationReferral1789500000000 } from './1789500000000-add-organization-referral-migration'
import { AddOrganizationInvitationAttribution1790035200000 } from './1790035200000-add-organization-invitation-attribution-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `organization_attribution_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('AddOrganizationInvitationAttribution1790035200000 (integration, real Postgres)', () => {
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
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser],
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

  it('stores shared attribution without a foreign key and rolls back only the new columns', async () => {
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      await queryRunner.query(`CREATE TABLE "organization" (
        "id" uuid PRIMARY KEY, "updatedAt" timestamptz NOT NULL DEFAULT now())`)
      await new AddOrganizationReferral1789500000000().up(queryRunner)
      const inviterId = randomUUID()
      const invitedIds = [randomUUID(), randomUUID()]
      await queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'ABCD2345EF')`, [
        inviterId,
      ])

      const migration = new AddOrganizationInvitationAttribution1790035200000()
      await migration.up(queryRunner)

      const [existing] = await queryRunner.query(
        `SELECT "referralCode", "referredCode", "inviterOrganizationId" FROM "organization"`,
      )
      expect(existing).toEqual({ referralCode: 'ABCD2345EF', referredCode: null, inviterOrganizationId: null })
      expect(await queryRunner.getTable('organization')).toEqual(
        expect.objectContaining({
          columns: expect.arrayContaining([
            expect.objectContaining({
              name: 'referredCode',
              type: 'character varying',
              length: '10',
              isNullable: true,
            }),
            expect.objectContaining({ name: 'inviterOrganizationId', type: 'uuid', isNullable: true }),
          ]),
        }),
      )
      const metadata = dataSource.getMetadata(Organization)
      expect(metadata.findColumnWithPropertyName('referredCode')).toMatchObject({
        type: 'varchar',
        length: '10',
        isNullable: true,
      })
      expect(metadata.findColumnWithPropertyName('inviterOrganizationId')).toMatchObject({
        type: 'uuid',
        isNullable: true,
      })

      await queryRunner.query(
        `INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'JKLMNP2345'), ($2, NULL)`,
        invitedIds,
      )
      const organizations = dataSource.getRepository(Organization)
      await organizations.update(invitedIds, { referredCode: 'ABCD2345EF', inviterOrganizationId: inviterId })
      await queryRunner.query(`DELETE FROM "organization" WHERE "id" = $1`, [inviterId])
      const invited = await organizations
        .createQueryBuilder('organization')
        .select([
          'organization.id',
          'organization.referralCode',
          'organization.referredCode',
          'organization.inviterOrganizationId',
        ])
        .getMany()
      expect(invited).toHaveLength(2)
      for (const organization of invited) {
        expect(organization).toMatchObject({ referredCode: 'ABCD2345EF', inviterOrganizationId: inviterId })
      }

      await migration.down(queryRunner)
      expect(await queryRunner.hasColumn('organization', 'referredCode')).toBe(false)
      expect(await queryRunner.hasColumn('organization', 'inviterOrganizationId')).toBe(false)
      expect(
        await queryRunner.query(`SELECT "referralCode" FROM "organization" WHERE "id" = $1`, [invitedIds[0]]),
      ).toEqual([{ referralCode: 'JKLMNP2345' }])
      await expect(
        queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'JKLMNP2345')`, [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'organization_referral_code_uq' })
    } finally {
      await queryRunner.release()
    }
  })
})
