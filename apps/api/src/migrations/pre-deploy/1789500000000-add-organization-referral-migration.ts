import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationReferral1789500000000 implements MigrationInterface {
  name = 'AddOrganizationReferral1789500000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization"
      ADD "referralCode" varchar(10),
      ADD CONSTRAINT "organization_referral_code_uq" UNIQUE ("referralCode")`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization" DROP COLUMN "referralCode"`)
  }
}
