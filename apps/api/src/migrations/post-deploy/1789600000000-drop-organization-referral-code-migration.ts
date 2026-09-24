import { MigrationInterface, QueryRunner } from 'typeorm'

export class DropOrganizationReferralCode1789600000000 implements MigrationInterface {
  name = 'DropOrganizationReferralCode1789600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Contract step for reverting #1573. Its pre-deploy migration stays in history
    // because it has already run on some databases, so this drops what it added;
    // IF EXISTS keeps the step safe on databases that never ran it.
    await queryRunner.query(
      `ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_referral_code_uq", DROP COLUMN IF EXISTS "referralCode"`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate rather than no-op: the pre-deploy migration's own down drops the
    // column unguarded, and a rolled-back API still maps it. The column held no data.
    await queryRunner.query(`ALTER TABLE "organization"
      ADD "referralCode" varchar(10),
      ADD CONSTRAINT "organization_referral_code_uq" UNIQUE ("referralCode")`)
  }
}
