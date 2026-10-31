import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddUserReferredByOrganization1790500000000 implements MigrationInterface {
  name = 'AddUserReferredByOrganization1790500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "referredByOrganizationId" uuid`)
    await queryRunner.query(
      `CREATE INDEX "user_referred_by_organization_idx" ON "user" ("referredByOrganizationId") WHERE "referredByOrganizationId" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "user_referred_by_organization_idx"`)
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "referredByOrganizationId"`)
  }
}
