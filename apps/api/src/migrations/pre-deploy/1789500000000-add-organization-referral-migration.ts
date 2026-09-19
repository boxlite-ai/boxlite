import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationReferral1789500000000 implements MigrationInterface {
  name = 'AddOrganizationReferral1789500000000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "organization"
      ADD "referralCode" varchar(10),
      ADD "referredCode" varchar(10),
      ADD "inviterOrganizationId" uuid,
      ADD CONSTRAINT "organization_referral_code_uq" UNIQUE ("referralCode")`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE "organization" IN ACCESS EXCLUSIVE MODE')
    const [usage] = await runner.query(`SELECT EXISTS (
      SELECT 1 FROM "organization" WHERE "referralCode" IS NOT NULL
        OR "referredCode" IS NOT NULL OR "inviterOrganizationId" IS NOT NULL
    ) AS used`)
    if (usage.used) throw new Error('Invitation data exists; roll back the application and retain the schema')
    await runner.query(`ALTER TABLE "organization" DROP COLUMN "inviterOrganizationId",
      DROP COLUMN "referredCode", DROP COLUMN "referralCode"`)
  }
}
